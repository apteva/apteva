import { useState, useEffect } from "react";
import { useAuth } from "../../context";

interface OpenApiPath {
  [method: string]: {
    tags?: string[];
    summary?: string;
    description?: string;
    parameters?: Array<{
      name: string;
      in: string;
      required?: boolean;
      schema?: { type: string };
      description?: string;
    }>;
    requestBody?: {
      required?: boolean;
      content?: {
        [mediaType: string]: {
          schema?: any;
        };
      };
    };
    responses?: {
      [code: string]: {
        description?: string;
        content?: any;
      };
    };
  };
}

interface OpenApiSpec {
  info: {
    title: string;
    description: string;
    version: string;
  };
  tags?: Array<{ name: string; description: string }>;
  paths: { [path: string]: OpenApiPath };
  components?: {
    schemas?: { [name: string]: any };
  };
}

const METHOD_COLORS: Record<string, string> = {
  get: "#61affe",
  post: "#49cc90",
  put: "#fca130",
  delete: "#f93e3e",
  patch: "#50e3c2",
};

export function ApiDocsPage() {
  const { authFetch } = useAuth();
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadSpec();
  }, []);

  async function copyToClipboard() {
    if (!spec) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(spec, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  function downloadJson() {
    if (!spec) return;
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "apteva-openapi.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadSpec() {
    try {
      const res = await authFetch("/api/openapi");
      if (res.ok) {
        const data = await res.json();
        setSpec(data);
      }
    } catch (err) {
      console.error("Failed to load OpenAPI spec:", err);
    } finally {
      setLoading(false);
    }
  }

  function togglePath(pathKey: string) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) {
        next.delete(pathKey);
      } else {
        next.add(pathKey);
      }
      return next;
    });
  }

  function getSchemaPreview(schema: any, depth = 0): string {
    if (!schema) return "{}";
    if (depth > 2) return "...";

    if (schema.$ref) {
      const refName = schema.$ref.split("/").pop();
      return refName || "Object";
    }

    if (schema.type === "array") {
      const itemType = getSchemaPreview(schema.items, depth + 1);
      return `${itemType}[]`;
    }

    if (schema.type === "object" && schema.properties) {
      const props = Object.entries(schema.properties)
        .slice(0, 3)
        .map(([k, v]: [string, any]) => `${k}: ${v.type || "any"}`)
        .join(", ");
      const more = Object.keys(schema.properties).length > 3 ? ", ..." : "";
      return `{ ${props}${more} }`;
    }

    return schema.type || "any";
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "#888" }}>Loading API documentation...</p>
      </div>
    );
  }

  if (!spec) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "#f66" }}>Failed to load API documentation</p>
      </div>
    );
  }

  const tags = spec.tags || [];
  const paths = Object.entries(spec.paths);

  // Extract schema names referenced by a method
  function getReferencedSchemas(method: any): Set<string> {
    const refs = new Set<string>();

    function extractRefs(obj: any) {
      if (!obj) return;
      if (typeof obj === "object") {
        if (obj.$ref) {
          const name = obj.$ref.split("/").pop();
          if (name) refs.add(name);
        }
        for (const value of Object.values(obj)) {
          extractRefs(value);
        }
      }
    }

    extractRefs(method.requestBody);
    extractRefs(method.responses);
    return refs;
  }

  // Get all schemas referenced by filtered endpoints
  function getFilteredSchemas(): string[] {
    if (!selectedTag || !spec.components?.schemas) {
      return Object.keys(spec.components?.schemas || {});
    }

    const usedSchemas = new Set<string>();

    for (const [_, methods] of filteredPaths) {
      for (const [method, details] of Object.entries(methods)) {
        if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
        if (details.tags?.includes(selectedTag)) {
          const refs = getReferencedSchemas(details);
          refs.forEach(r => usedSchemas.add(r));
        }
      }
    }

    return Array.from(usedSchemas);
  }

  // Filter paths by selected tag
  const filteredPaths = selectedTag
    ? paths.filter(([_, methods]) =>
        Object.values(methods).some((m) => m.tags?.includes(selectedTag))
      )
    : paths;

  return (
    <div style={{ padding: 24, maxWidth: 1000, height: "100%", overflowY: "auto" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>
            {spec.info.title}
          </h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={copyToClipboard}
              style={{
                padding: "8px 16px",
                borderRadius: 4,
                border: "1px solid #333",
                background: copied ? "#49cc90" : "#1a1a2e",
                color: copied ? "#000" : "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "inherit",
              }}
            >
              {copied ? "Copied!" : "Copy JSON"}
            </button>
            <button
              onClick={downloadJson}
              style={{
                padding: "8px 16px",
                borderRadius: 4,
                border: "1px solid #333",
                background: "#1a1a2e",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "inherit",
              }}
            >
              Download
            </button>
          </div>
        </div>
        <p style={{ color: "#888", marginBottom: 8 }}>
          {spec.info.description.split("\n")[0]}
        </p>
        <p style={{ color: "#666", fontSize: 12 }}>Version: {spec.info.version}</p>
      </div>

      {/* Base URL */}
      <div
        style={{
          background: "#1a1a2e",
          padding: 12,
          borderRadius: 6,
          marginBottom: 24,
          fontFamily: "monospace",
        }}
      >
        <span style={{ color: "#888" }}>Base URL: </span>
        <span style={{ color: "#61affe" }}>
          {window.location.origin}/api
        </span>
      </div>

      {/* Tag filters */}
      <div style={{ marginBottom: 24, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => setSelectedTag(null)}
          style={{
            padding: "6px 12px",
            borderRadius: 4,
            border: "1px solid #333",
            background: selectedTag === null ? "#333" : "transparent",
            color: selectedTag === null ? "#fff" : "#888",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          All
        </button>
        {tags.map((tag) => (
          <button
            key={tag.name}
            onClick={() => setSelectedTag(tag.name)}
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: "1px solid #333",
              background: selectedTag === tag.name ? "#333" : "transparent",
              color: selectedTag === tag.name ? "#fff" : "#888",
              cursor: "pointer",
              fontSize: 12,
            }}
            title={tag.description}
          >
            {tag.name}
          </button>
        ))}
      </div>

      {/* Endpoints */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredPaths.map(([path, methods]) =>
          Object.entries(methods)
            .filter(([method]) => ["get", "post", "put", "delete", "patch"].includes(method))
            .map(([method, details]) => {
              const pathKey = `${method}:${path}`;
              const isExpanded = expandedPaths.has(pathKey);
              const methodUpper = method.toUpperCase();
              const color = METHOD_COLORS[method] || "#888";

              return (
                <div
                  key={pathKey}
                  style={{
                    border: "1px solid #333",
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  {/* Header */}
                  <div
                    onClick={() => togglePath(pathKey)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      background: isExpanded ? "#1a1a2e" : "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        background: color,
                        color: "#000",
                        padding: "4px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        minWidth: 60,
                        textAlign: "center",
                      }}
                    >
                      {methodUpper}
                    </span>
                    <span style={{ fontFamily: "monospace", color: "#fff" }}>
                      {path}
                    </span>
                    <span style={{ color: "#888", flex: 1, fontSize: 13 }}>
                      {details.summary}
                    </span>
                    <span style={{ color: "#666", fontSize: 12 }}>
                      {isExpanded ? "[-]" : "[+]"}
                    </span>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: 16,
                        background: "#0d0d1a",
                        borderTop: "1px solid #333",
                      }}
                    >
                      {details.description && (
                        <p style={{ color: "#888", marginBottom: 16, fontSize: 13 }}>
                          {details.description}
                        </p>
                      )}

                      {/* Parameters */}
                      {details.parameters && details.parameters.length > 0 && (
                        <div style={{ marginBottom: 16 }}>
                          <h4 style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                            Parameters
                          </h4>
                          <div
                            style={{
                              background: "#1a1a2e",
                              borderRadius: 4,
                              padding: 12,
                            }}
                          >
                            {details.parameters.map((param) => (
                              <div
                                key={param.name}
                                style={{
                                  display: "flex",
                                  gap: 12,
                                  marginBottom: 8,
                                  fontSize: 12,
                                }}
                              >
                                <span style={{ color: "#61affe", minWidth: 100 }}>
                                  {param.name}
                                  {param.required && (
                                    <span style={{ color: "#f66" }}>*</span>
                                  )}
                                </span>
                                <span style={{ color: "#666" }}>({param.in})</span>
                                <span style={{ color: "#888" }}>
                                  {param.schema?.type || "string"}
                                </span>
                                {param.description && (
                                  <span style={{ color: "#666" }}>
                                    - {param.description}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Request Body */}
                      {details.requestBody && (
                        <div style={{ marginBottom: 16 }}>
                          <h4 style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                            Request Body
                            {details.requestBody.required && (
                              <span style={{ color: "#f66" }}> (required)</span>
                            )}
                          </h4>
                          <div
                            style={{
                              background: "#1a1a2e",
                              borderRadius: 4,
                              padding: 12,
                              fontFamily: "monospace",
                              fontSize: 12,
                              color: "#49cc90",
                            }}
                          >
                            {Object.entries(details.requestBody.content || {}).map(
                              ([mediaType, content]) => (
                                <div key={mediaType}>
                                  <span style={{ color: "#666" }}>{mediaType}: </span>
                                  {getSchemaPreview(content.schema)}
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      )}

                      {/* Responses */}
                      {details.responses && (
                        <div>
                          <h4 style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                            Responses
                          </h4>
                          <div
                            style={{
                              background: "#1a1a2e",
                              borderRadius: 4,
                              padding: 12,
                            }}
                          >
                            {Object.entries(details.responses).map(([code, resp]) => {
                              const respContent = resp.content?.["application/json"]?.schema;
                              const schemaRef = respContent?.$ref?.split("/").pop();
                              const schemaType = respContent?.type;
                              const schemaItems = respContent?.items?.$ref?.split("/").pop();

                              return (
                                <div
                                  key={code}
                                  style={{
                                    marginBottom: 12,
                                    fontSize: 12,
                                  }}
                                >
                                  <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
                                    <span
                                      style={{
                                        color: code.startsWith("2") ? "#49cc90" : "#f66",
                                        minWidth: 40,
                                      }}
                                    >
                                      {code}
                                    </span>
                                    <span style={{ color: "#888" }}>{resp.description}</span>
                                  </div>
                                  {respContent && (
                                    <div
                                      style={{
                                        marginLeft: 52,
                                        padding: "8px 12px",
                                        background: "#0d0d1a",
                                        borderRadius: 4,
                                        fontFamily: "monospace",
                                      }}
                                    >
                                      {schemaRef ? (
                                        <span style={{ color: "#61affe" }}>{schemaRef}</span>
                                      ) : schemaType === "array" && schemaItems ? (
                                        <span style={{ color: "#61affe" }}>{schemaItems}[]</span>
                                      ) : schemaType === "array" ? (
                                        <span style={{ color: "#888" }}>array</span>
                                      ) : (
                                        <span style={{ color: "#888" }}>{getSchemaPreview(respContent)}</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>

      {/* Schemas section */}
      {spec.components?.schemas && getFilteredSchemas().length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>
            Schemas {selectedTag && <span style={{ color: "#666", fontSize: 14 }}>({selectedTag})</span>}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {getFilteredSchemas().map((name) => {
              const schema = spec.components!.schemas![name];
              if (!schema) return null;
              return (
                <div
                  key={name}
                  style={{
                    border: "1px solid #333",
                    borderRadius: 6,
                    padding: 12,
                  }}
                >
                  <h3 style={{ fontSize: 14, color: "#61affe", marginBottom: 8 }}>
                    {name}
                  </h3>
                  {schema.properties && (
                    <div style={{ fontSize: 12 }}>
                      {Object.entries(schema.properties).map(([prop, propSchema]: [string, any]) => (
                        <div
                          key={prop}
                          style={{
                            display: "flex",
                            gap: 8,
                            marginBottom: 4,
                            fontFamily: "monospace",
                          }}
                        >
                          <span style={{ color: "#fff", minWidth: 120 }}>{prop}</span>
                          <span style={{ color: "#888" }}>
                            {propSchema.type || (propSchema.$ref ? propSchema.$ref.split("/").pop() : "any")}
                            {propSchema.nullable && " | null"}
                          </span>
                          {propSchema.enum && (
                            <span style={{ color: "#666" }}>
                              [{propSchema.enum.join(" | ")}]
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
