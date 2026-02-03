// Skills Integration Provider
// Fetches from public GitHub repositories

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  content: string; // Full SKILL.md content
  author: string;
  version: string;
  license: string | null;
  compatibility: string | null;
  tags: string[];
  downloads: number;
  rating: number;
  repository: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillsSearchResult {
  skills: MarketplaceSkill[];
  total: number;
  page: number;
  per_page: number;
}

// GitHub repo sources
// Add more repositories here as the skills ecosystem grows
// Each repo should have folders containing SKILL.md files with YAML frontmatter
const GITHUB_REPOS = [
  {
    owner: "anthropics",
    repo: "skills",
    path: "skills",
    author: "Anthropic",
  },
  // Community repos can be added here, e.g.:
  // { owner: "some-org", repo: "claude-skills", path: "skills", author: "Community" },
];

// Cache for fetched skills (TTL: 5 minutes)
let skillsCache: { skills: MarketplaceSkill[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

// Fetch all skills from GitHub repos
async function fetchAllSkills(): Promise<MarketplaceSkill[]> {
  // Check cache
  if (skillsCache && Date.now() - skillsCache.fetchedAt < CACHE_TTL) {
    return skillsCache.skills;
  }

  const allSkills: MarketplaceSkill[] = [];

  for (const repo of GITHUB_REPOS) {
    try {
      // Fetch directory listing
      const listRes = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.path}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Apteva-Skills-Fetcher",
          },
        }
      );

      if (!listRes.ok) {
        console.error(`Failed to fetch ${repo.owner}/${repo.repo}: ${listRes.status}`);
        continue;
      }

      const items = (await listRes.json()) as Array<{
        name: string;
        type: string;
        path: string;
      }>;

      // Filter directories only
      const skillDirs = items.filter((item) => item.type === "dir");

      // Fetch each skill's SKILL.md
      const skillPromises = skillDirs.map(async (dir) => {
        try {
          const skillMdRes = await fetch(
            `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/${dir.path}/SKILL.md`,
            {
              headers: { "User-Agent": "Apteva-Skills-Fetcher" },
            }
          );

          if (!skillMdRes.ok) {
            return null;
          }

          const content = await skillMdRes.text();
          const parsed = parseSkillMd(content);

          if (!parsed) {
            return null;
          }

          return {
            id: `${repo.owner}-${dir.name}`,
            name: parsed.name,
            description: parsed.description,
            content,
            author: repo.author,
            version: parsed.metadata?.version || "1.0.0",
            license: parsed.license || "MIT",
            compatibility: parsed.compatibility || null,
            tags: inferTags(dir.name, parsed.description),
            downloads: 0, // Not available from GitHub
            rating: 4.5, // Default rating
            repository: `https://github.com/${repo.owner}/${repo.repo}/tree/main/${dir.path}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as MarketplaceSkill;
        } catch (e) {
          console.error(`Failed to fetch skill ${dir.name}:`, e);
          return null;
        }
      });

      const skills = (await Promise.all(skillPromises)).filter(
        (s): s is MarketplaceSkill => s !== null
      );
      allSkills.push(...skills);
    } catch (e) {
      console.error(`Failed to fetch from ${repo.owner}/${repo.repo}:`, e);
    }
  }

  // Update cache
  skillsCache = { skills: allSkills, fetchedAt: Date.now() };

  return allSkills;
}

// Infer tags from skill name and description
function inferTags(name: string, description: string): string[] {
  const tags: string[] = [];
  const text = `${name} ${description}`.toLowerCase();

  const tagKeywords: Record<string, string[]> = {
    pdf: ["pdf"],
    document: ["doc", "docx", "document", "word"],
    spreadsheet: ["xlsx", "excel", "spreadsheet"],
    presentation: ["pptx", "powerpoint", "slides", "presentation"],
    design: ["design", "ui", "frontend", "canvas", "art"],
    code: ["code", "programming", "developer", "builder"],
    mcp: ["mcp"],
    testing: ["test", "testing", "qa"],
    communication: ["slack", "comms", "communication"],
    brand: ["brand", "guidelines"],
  };

  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.length > 0 ? tags : ["general"];
}

// Provider interface
export interface SkillsProvider {
  id: string;
  name: string;
  search(query: string, page?: number): Promise<SkillsSearchResult>;
  getSkill(skillId: string): Promise<MarketplaceSkill | null>;
  getFeatured(): Promise<MarketplaceSkill[]>;
  getCategories(): Promise<string[]>;
}

export const GithubSkillsProvider: SkillsProvider = {
  id: "github",
  name: "GitHub Public Skills",

  async search(query: string, page = 1): Promise<SkillsSearchResult> {
    const allSkills = await fetchAllSkills();

    if (!query.trim()) {
      return {
        skills: allSkills,
        total: allSkills.length,
        page: 1,
        per_page: 50,
      };
    }

    const lowerQuery = query.toLowerCase();
    const filtered = allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(lowerQuery) ||
        s.description.toLowerCase().includes(lowerQuery) ||
        s.tags.some((t) => t.toLowerCase().includes(lowerQuery))
    );

    return {
      skills: filtered,
      total: filtered.length,
      page: 1,
      per_page: 50,
    };
  },

  async getSkill(skillId: string): Promise<MarketplaceSkill | null> {
    const allSkills = await fetchAllSkills();
    return allSkills.find((s) => s.id === skillId) || null;
  },

  async getFeatured(): Promise<MarketplaceSkill[]> {
    const allSkills = await fetchAllSkills();
    // Return all skills sorted by name
    return [...allSkills].sort((a, b) => a.name.localeCompare(b.name));
  },

  async getCategories(): Promise<string[]> {
    const allSkills = await fetchAllSkills();
    const tags = new Set<string>();
    allSkills.forEach((s) => s.tags.forEach((t) => tags.add(t)));
    return Array.from(tags).sort();
  },
};

// Legacy export for compatibility (uses GitHub provider now)
export const SkillsmpProvider = {
  id: "skillsmp",
  name: "SkillsMP",

  async search(apiKey: string, query: string, page = 1): Promise<SkillsSearchResult> {
    // Ignore API key, use GitHub provider
    return GithubSkillsProvider.search(query, page);
  },

  async getSkill(apiKey: string, skillId: string): Promise<MarketplaceSkill | null> {
    return GithubSkillsProvider.getSkill(skillId);
  },

  async getFeatured(apiKey: string): Promise<MarketplaceSkill[]> {
    return GithubSkillsProvider.getFeatured();
  },

  async getCategories(apiKey: string): Promise<string[]> {
    return GithubSkillsProvider.getCategories();
  },
};

// Parse SKILL.md content into structured data
export function parseSkillMd(content: string): {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
} | null {
  // Check for YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatter, body] = frontmatterMatch;

  // Parse YAML (simple parser for common fields)
  const yaml: Record<string, any> = {};
  const lines = frontmatter.split("\n");
  let inMetadata = false;

  for (const line of lines) {
    if (line.startsWith("metadata:")) {
      inMetadata = true;
      yaml.metadata = {};
      continue;
    }

    if (inMetadata) {
      if (line.startsWith("  ")) {
        const match = line.trim().match(/^(\w+):\s*["']?(.*)["']?$/);
        if (match) {
          yaml.metadata[match[1]] = match[2].replace(/["']$/, "");
        }
      } else {
        inMetadata = false;
      }
    }

    if (!inMetadata) {
      const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        yaml[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  }

  if (!yaml.name || !yaml.description) {
    return null;
  }

  return {
    name: yaml.name,
    description: yaml.description,
    body: body.trim(),
    license: yaml.license,
    compatibility: yaml.compatibility,
    metadata: yaml.metadata,
    allowedTools: yaml["allowed-tools"]?.split(/\s+/).filter(Boolean),
  };
}

// Re-export types for backwards compatibility
export type SkillsmpSkill = MarketplaceSkill;
export type SkillsmpSearchResult = SkillsSearchResult;
