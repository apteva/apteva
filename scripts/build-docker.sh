#!/bin/bash

# Build Docker/Podman image with automatic version tagging
# Usage: ./scripts/build-docker.sh [--push] [--latest]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Auto-detect container runtime (prefer docker, fallback to podman)
if command -v docker &> /dev/null; then
    CONTAINER_CMD="docker"
elif command -v podman &> /dev/null; then
    CONTAINER_CMD="podman"
else
    echo -e "${RED}Error: Neither docker nor podman found${NC}"
    exit 1
fi

echo -e "${BLUE}Using container runtime: ${GREEN}$CONTAINER_CMD${NC}"

# Default values
PUSH=false
TAG_LATEST=true
IMAGE_NAME="apteva/apteva"
REGISTRY=""

# Registry presets
REGISTRY_PRODUCTION="registry.omnikit.co"

# Default to production registry
DEFAULT_REGISTRY="$REGISTRY_PRODUCTION"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --push)
            PUSH=true
            shift
            ;;
        --no-latest)
            TAG_LATEST=false
            shift
            ;;
        --image-name)
            IMAGE_NAME="$2"
            shift 2
            ;;
        --registry)
            REGISTRY="$2"
            PUSH=true
            shift 2
            ;;
        --production)
            REGISTRY="$REGISTRY_PRODUCTION"
            PUSH=true
            shift
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --push         Push to registry.omnikit.co (default registry)"
            echo "  --production   Same as --push"
            echo "  --no-latest    Skip tagging as 'latest' (latest is created by default)"
            echo "  --image-name   Set custom image name (default: apteva/apteva)"
            echo "  --registry     Push to custom registry URL"
            echo ""
            echo "Examples:"
            echo "  $0                           # Build locally only"
            echo "  $0 --push                    # Build and push to registry.omnikit.co"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

# Read version from package.json
if [[ ! -f "package.json" ]]; then
    echo -e "${RED}Error: package.json not found${NC}"
    exit 1
fi

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [[ -z "$VERSION" ]]; then
    echo -e "${RED}Error: Could not read version from package.json${NC}"
    exit 1
fi

echo -e "${BLUE}Building Docker image for version: ${GREEN}$VERSION${NC}"

# Build the container image
echo -e "${YELLOW}Building image...${NC}"
$CONTAINER_CMD build \
    --build-arg VERSION="$VERSION" \
    -f docker/Dockerfile \
    -t "$IMAGE_NAME:$VERSION" \
    .

# Tag as latest (default behavior)
if [[ "$TAG_LATEST" == true ]]; then
    echo -e "${YELLOW}Tagging as latest...${NC}"
    $CONTAINER_CMD tag "$IMAGE_NAME:$VERSION" "$IMAGE_NAME:latest"
fi

echo -e "${GREEN}✅ Successfully built Docker image${NC}"
echo -e "${BLUE}Tags created:${NC}"
echo -e "  - $IMAGE_NAME:$VERSION"

if [[ "$TAG_LATEST" == true ]]; then
    echo -e "  - $IMAGE_NAME:latest"
fi

# Function to push to a registry
push_to_registry() {
    local REG="$1"
    local REGISTRY_IMAGE="$REG/$IMAGE_NAME"

    echo -e "${YELLOW}Tagging for registry: ${GREEN}$REG${NC}"

    $CONTAINER_CMD tag "$IMAGE_NAME:$VERSION" "$REGISTRY_IMAGE:$VERSION"
    echo -e "  - Tagged: $REGISTRY_IMAGE:$VERSION"

    if [[ "$TAG_LATEST" == true ]]; then
        $CONTAINER_CMD tag "$IMAGE_NAME:$VERSION" "$REGISTRY_IMAGE:latest"
        echo -e "  - Tagged: $REGISTRY_IMAGE:latest"
    fi

    echo -e "${YELLOW}Pushing to registry...${NC}"
    $CONTAINER_CMD push "$REGISTRY_IMAGE:$VERSION"

    if [[ "$TAG_LATEST" == true ]]; then
        $CONTAINER_CMD push "$REGISTRY_IMAGE:latest"
    fi

    echo -e "${GREEN}✅ Successfully pushed to $REG${NC}"
}

# Push to registry if requested
if [[ "$PUSH" == true ]]; then
    if [[ -n "$REGISTRY" ]]; then
        push_to_registry "$REGISTRY"
    else
        push_to_registry "$DEFAULT_REGISTRY"
    fi
fi

# Show image size
echo -e "${BLUE}Image size:${NC}"
$CONTAINER_CMD images "$IMAGE_NAME:$VERSION" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

echo -e "${GREEN}Build complete!${NC}"
echo -e "${BLUE}To run the container:${NC}"
echo -e "  $CONTAINER_CMD run -p 3000:3000 -v apteva_data:/data $IMAGE_NAME:$VERSION"
