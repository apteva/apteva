package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const serverLogMaxBytes int64 = 100 << 20

// serverLogCapture owns the OS pipe attached to a spawned server. Using an
// explicit pipe (rather than giving exec.Cmd a custom io.Writer) keeps shutdown
// bounded even when a core grandchild temporarily retains stdout/stderr.
type serverLogCapture struct {
	log               *serverLogWriter
	reader            *os.File
	childWriter       *os.File
	done              chan struct{}
	childWriterClosed sync.Once
	closeOnce         sync.Once
	copyErr           error
	closeErr          error
}

func newServerLogCapture(path string, maxBytes int64) (*serverLogCapture, error) {
	logWriter, err := newServerLogWriter(path, maxBytes)
	if err != nil {
		return nil, err
	}
	reader, childWriter, err := os.Pipe()
	if err != nil {
		_ = logWriter.Close()
		return nil, err
	}
	capture := &serverLogCapture{
		log:         logWriter,
		reader:      reader,
		childWriter: childWriter,
		done:        make(chan struct{}),
	}
	go capture.copyLoop()
	return capture, nil
}

func (c *serverLogCapture) Attach(cmd *exec.Cmd) {
	cmd.Stdout = c.childWriter
	cmd.Stderr = c.childWriter
}

// ReleaseParentWriter is called immediately after Start. The spawned process
// owns duplicated descriptors; retaining the launcher's copy would prevent EOF.
func (c *serverLogCapture) ReleaseParentWriter() {
	c.childWriterClosed.Do(func() {
		_ = c.childWriter.Close()
	})
}

func (c *serverLogCapture) Close() error {
	c.closeOnce.Do(func() {
		c.ReleaseParentWriter()
		select {
		case <-c.done:
			// The server and its children closed their descriptors; all output
			// was drained normally.
		case <-time.After(250 * time.Millisecond):
			// A force-killed server may leave a detached core holding the pipe.
			// Close our reader so shutdown and log cleanup remain bounded.
			_ = c.reader.Close()
			<-c.done
		}
		_ = c.reader.Close()
		c.closeErr = errors.Join(c.copyErr, c.log.Close())
	})
	return c.closeErr
}

func (c *serverLogCapture) copyLoop() {
	defer close(c.done)
	buf := make([]byte, 32<<10)
	for {
		n, readErr := c.reader.Read(buf)
		if n > 0 {
			if _, writeErr := c.log.Write(buf[:n]); writeErr != nil && c.copyErr == nil {
				// Continue draining after a rotation error so a noisy child can
				// never block on a full pipe. The writer retries on the next chunk.
				c.copyErr = writeErr
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, os.ErrClosed) && c.copyErr == nil {
				c.copyErr = readErr
			}
			return
		}
	}
}

// serverLogWriter bounds the combined stdout/stderr stream from the locally
// spawned server and its core children. One active file and one rotated copy
// are retained, each capped at maxBytes.
type serverLogWriter struct {
	mu         sync.Mutex
	path       string
	maxBytes   int64
	file       *os.File
	size       int64
	closed     bool
	rotatePath func(string) error
}

func newServerLogWriter(path string, maxBytes int64) (*serverLogWriter, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("server log max bytes must be positive")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil && info.Size() > maxBytes {
		if err := preserveServerLogTail(path, maxBytes); err != nil {
			return nil, err
		}
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}

	w := &serverLogWriter{
		path:       path,
		maxBytes:   maxBytes,
		rotatePath: rotateServerLogPath,
	}
	if err := w.openAppendLocked(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *serverLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return 0, os.ErrClosed
	}
	if w.file == nil {
		if err := w.openAppendLocked(); err != nil {
			return 0, err
		}
	}

	consumed := len(p)
	if int64(len(p)) > w.maxBytes {
		p = p[len(p)-int(w.maxBytes):]
	}
	if w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}

	n, err := w.file.Write(p)
	w.size += int64(n)
	if err != nil {
		return n, err
	}
	if n != len(p) {
		return n, io.ErrShortWrite
	}
	return consumed, nil
}

func (w *serverLogWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (w *serverLogWriter) rotateLocked() error {
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			return err
		}
		w.file = nil
	}
	if err := w.rotatePath(w.path); err != nil {
		// A failed rename must not permanently disable logging. Reopen the
		// original active file in append mode, then surface the rotation error.
		return errors.Join(err, w.openAppendLocked())
	}
	return w.openAppendLocked()
}

func (w *serverLogWriter) openAppendLocked() error {
	f, err := os.OpenFile(w.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	w.file = f
	w.size = info.Size()
	return nil
}

func rotateServerLogPath(path string) error {
	rotated := path + ".1"
	if err := os.Remove(rotated); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(path, rotated); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// preserveServerLogTail replaces an oversized active log with an empty file
// and stores only its newest keepBytes in the rotated copy. The original is
// not truncated until the bounded backup has been written successfully.
func preserveServerLogTail(path string, keepBytes int64) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	info, err := in.Stat()
	if err != nil {
		_ = in.Close()
		return err
	}
	start := info.Size() - keepBytes
	if start < 0 {
		start = 0
	}
	if _, err := in.Seek(start, io.SeekStart); err != nil {
		_ = in.Close()
		return err
	}

	rotated := path + ".1"
	tmp := rotated + ".tmp"
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		_ = in.Close()
		return err
	}
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		_ = in.Close()
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeOutErr := out.Close()
	closeInErr := in.Close()
	if copyErr != nil || closeOutErr != nil || closeInErr != nil {
		_ = os.Remove(tmp)
		return errors.Join(copyErr, closeOutErr, closeInErr)
	}
	if err := os.Remove(rotated); err != nil && !os.IsNotExist(err) {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, rotated); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Truncate(path, 0)
}
