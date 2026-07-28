use std::{
    collections::BTreeMap,
    path::Path,
    time::Duration,
};

use reqwest::Client;
use serde_json::Value;

use crate::{
    error::AppError,
    mcp_repository::McpRepository,
    models::{
        CreateMcpServerInput, ExtensionCatalogEntry, ExtensionInstallResult, ExtensionStore,
        McpServer, SkillSummary,
    },
    skill_service::SkillService,
};

const USER_AGENT: &str = "prometheus-control-plane/0.1 (extension-catalog)";

#[derive(Clone, Debug)]
struct BuiltinSkillEntry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    homepage: &'static str,
    tags: &'static [&'static str],
    source: BuiltinSkillSource,
}

#[derive(Clone, Debug)]
enum BuiltinSkillSource {
    Inline {
        skill_md: &'static str,
    },
    Github {
        repo: &'static str,
        path: &'static str,
        r#ref: &'static str,
    },
}

#[derive(Clone, Debug)]
struct BuiltinMcpEntry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    homepage: &'static str,
    tags: &'static [&'static str],
    command: &'static str,
    args: &'static [&'static str],
    env_keys: &'static [&'static str],
    default_enabled: bool,
}

const SKILL_STORE_ID: &str = "open-skills";
const MCP_STORE_ID: &str = "open-mcp";
const ANBEIME_SKILL_STORE_ID: &str = "anbeime-skill";
const ANBEIME_REPO: &str = "anbeime/skill";
const ANBEIME_REF: &str = "main";
const ANBEIME_SKILLS_PATH: &str = "skills";
const ANBEIME_INDEX_PATH: &str = "data/skills.json";

const ANBEIME_PACKAGED_SKILLS: &[&str] = &[
    "NanoBanana-PPT-Skills",
    "agent-team",
    "agentkit-multimedia-shopping",
    "ai-drawio",
    "article-illustrator",
    "baoyu-format-markdown",
    "baoyu-post-to-wechat",
    "baoyu-post-to-x",
    "baoyu-url-to-markdown",
    "baoyu-xhs-images",
    "content-creation-publisher",
    "contract-review",
    "creating-financial-models",
    "digital-avatar-shopping-video",
    "docx",
    "dream-video-prompt-generator",
    "ecommerce-copywriter",
    "ecommerce-video-marketing",
    "find-skill",
    "frontend-design",
    "historical-interview-scripts",
    "historical-science-video-prod",
    "infinitetalk",
    "infinitetalk-shopping-avatar",
    "intelligent-content-system",
    "law-to-markdown",
    "market-research-reports",
    "multi-agent-meeting",
    "nanobanana-ppt-visualizer",
    "paper-analysis-assistant",
    "pdf",
    "peers-advisory-group",
    "pet-commerce-creator",
    "poetry-music-visual",
    "pop-up-book-illustration",
    "ppt-generator",
    "ppt-roadshow-generator",
    "pptx",
    "pptx-generator",
    "product-manager-toolkit",
    "product-marketing-copywriter",
    "product-video-creator",
    "qwen3-asr-assistant",
    "qwen3-tts-local",
    "remotion-video-enhancer",
    "sales-ai-assistant",
    "skill-creator",
    "stock-analysis",
    "three-body-video-creator",
    "tts-voice-synthesis",
    "video-creation-collaborator",
    "video-creation-pro",
    "video-creation-suite",
    "video-frame-extractor",
    "video-recreation",
    "viral-video-copywriting",
    "web-to-app",
    "wechat-hotspot-publisher",
    "xiaohongshu-makeup",
    "xlsx",
];


const BUILTIN_SKILLS: &[BuiltinSkillEntry] = &[
    BuiltinSkillEntry {
        id: "prometheus-pr-review",
        name: "PR Review",
        description: "Structured pull-request review checklist covering risk, tests, and rollout notes.",
        homepage: "https://github.com/openai/skills",
        tags: &["git", "review", "quality"],
        source: BuiltinSkillSource::Inline {
            skill_md: r#"---
name: PR Review
description: Structured pull-request review checklist covering risk, tests, and rollout notes.
---

# PR Review

Use this skill when reviewing a pull request or preparing review comments.

## Checklist
1. Restate the intended change and blast radius.
2. Verify tests cover the changed behavior; note missing cases.
3. Flag security, data-loss, and permission risks.
4. Confirm docs/config/migration impact is explicit.
5. End with a clear ship/no-ship recommendation and residual risks.
"#,
        },
    },
    BuiltinSkillEntry {
        id: "prometheus-debug-loop",
        name: "Debug Loop",
        description: "Reproduce → minimise → hypothesis → instrument → fix → regression-test loop for hard bugs.",
        homepage: "https://github.com/openai/skills",
        tags: &["debug", "reliability"],
        source: BuiltinSkillSource::Inline {
            skill_md: r#"---
name: Debug Loop
description: Reproduce → minimise → hypothesis → instrument → fix → regression-test loop for hard bugs.
---

# Debug Loop

1. Reproduce with the smallest real command or API call.
2. Minimise inputs and isolate the failing layer.
3. Form one falsifiable hypothesis at a time.
4. Add the smallest instrumentation that proves or kills the hypothesis.
5. Fix the root cause, then add a regression test before cleanup.
"#,
        },
    },
    BuiltinSkillEntry {
        id: "gh-fix-ci",
        name: "Fix GitHub CI",
        description: "Inspect failing GitHub Actions checks, summarize root cause, and draft a focused fix.",
        homepage: "https://github.com/openai/skills/tree/main/skills/.curated",
        tags: &["github", "ci", "actions"],
        source: BuiltinSkillSource::Github {
            repo: "openai/skills",
            path: "skills/.system/skill-installer",
            r#ref: "main",
        },
    },
    BuiltinSkillEntry {
        id: "skill-creator",
        name: "Skill Creator",
        description: "Guide for creating effective agent skills with progressive disclosure.",
        homepage: "https://github.com/openai/skills/tree/main/skills/.system/skill-creator",
        tags: &["skills", "authoring"],
        source: BuiltinSkillSource::Github {
            repo: "openai/skills",
            path: "skills/.system/skill-creator",
            r#ref: "main",
        },
    },
    BuiltinSkillEntry {
        id: "find-skills",
        name: "Find Skills",
        description: "Discover installable skills from the open agent skills ecosystem.",
        homepage: "https://skills.sh/",
        tags: &["skills", "discovery"],
        source: BuiltinSkillSource::Github {
            repo: "vercel-labs/agent-skills",
            path: "skills/find-skills",
            r#ref: "main",
        },
    },
];

const BUILTIN_MCPS: &[BuiltinMcpEntry] = &[
    BuiltinMcpEntry {
        id: "mcp-memory",
        name: "memory",
        description: "Persistent memory knowledge graph MCP server from the official Model Context Protocol repo.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
        tags: &["memory", "knowledge"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-memory"],
        env_keys: &[],
        default_enabled: true,
    },
    BuiltinMcpEntry {
        id: "mcp-filesystem",
        name: "filesystem",
        description: "Official filesystem MCP server scoped to the active Prometheus workspace root.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        tags: &["files", "workspace"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-filesystem", "{{workspaceRoot}}"],
        env_keys: &[],
        default_enabled: true,
    },
    BuiltinMcpEntry {
        id: "mcp-fetch",
        name: "fetch",
        description: "HTTP fetch MCP server for retrieving web content as markdown or plain text.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
        tags: &["http", "web"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-fetch"],
        env_keys: &[],
        default_enabled: true,
    },
    BuiltinMcpEntry {
        id: "mcp-git",
        name: "git",
        description: "Git repository tools MCP server for status, diff, log, and branch inspection.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
        tags: &["git", "vcs"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-git", "--repository", "{{workspaceRoot}}"],
        env_keys: &[],
        default_enabled: true,
    },
    BuiltinMcpEntry {
        id: "mcp-sequential-thinking",
        name: "sequential-thinking",
        description: "Structured multi-step reasoning MCP server for complex problem decomposition.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
        tags: &["reasoning"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-sequential-thinking"],
        env_keys: &[],
        default_enabled: true,
    },
    BuiltinMcpEntry {
        id: "mcp-brave-search",
        name: "brave-search",
        description: "Brave Search MCP server. Requires BRAVE_API_KEY before enablement.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
        tags: &["search", "web"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-brave-search"],
        env_keys: &["BRAVE_API_KEY"],
        default_enabled: false,
    },
    BuiltinMcpEntry {
        id: "mcp-github",
        name: "github",
        description: "GitHub API MCP server for issues, PRs, and repository operations. Requires GITHUB_PERSONAL_ACCESS_TOKEN.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
        tags: &["github", "issues", "pr"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-github"],
        env_keys: &["GITHUB_PERSONAL_ACCESS_TOKEN"],
        default_enabled: false,
    },
    BuiltinMcpEntry {
        id: "mcp-sqlite",
        name: "sqlite",
        description: "SQLite MCP server for querying local databases. Pass DB path via args after install if needed.",
        homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
        tags: &["sqlite", "database"],
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-sqlite", "{{workspaceRoot}}"],
        env_keys: &[],
        default_enabled: false,
    },
];

#[derive(Clone)]
pub struct ExtensionCatalogService;

impl ExtensionCatalogService {
    pub fn new() -> Self {
        Self
    }

    pub fn list_stores(&self) -> Vec<ExtensionStore> {
        vec![
            ExtensionStore {
                id: SKILL_STORE_ID.to_owned(),
                kind: "skills".to_owned(),
                name: "Open Skills".to_owned(),
                description: "Default open skill catalog with bundled starters and GitHub-backed community skills.".to_owned(),
                source: "builtin+github".to_owned(),
                default_connected: true,
                homepage: Some("https://skills.sh/".to_owned()),
            },
            ExtensionStore {
                id: ANBEIME_SKILL_STORE_ID.to_owned(),
                kind: "skills".to_owned(),
                name: "Anbeime Skill Store".to_owned(),
                description: "Community skill marketplace from anbeime/skill: packaged installable skills plus crawled GitHub skill index.".to_owned(),
                source: "github:anbeime/skill".to_owned(),
                default_connected: true,
                homepage: Some("https://github.com/anbeime/skill".to_owned()),
            },
            ExtensionStore {
                id: MCP_STORE_ID.to_owned(),
                kind: "mcp".to_owned(),
                name: "Open MCP Servers".to_owned(),
                description: "Curated stdio MCP servers from the official Model Context Protocol ecosystem.".to_owned(),
                source: "builtin".to_owned(),
                default_connected: true,
                homepage: Some(
                    "https://github.com/modelcontextprotocol/servers".to_owned(),
                ),
            },
        ]
    }

    pub async fn list_catalog(
        &self,
        store_id: &str,
        query: Option<&str>,
        refresh_remote: bool,
        skills: &SkillService,
        mcp: &McpRepository,
        workspace_root: &Path,
    ) -> Result<Vec<ExtensionCatalogEntry>, AppError> {
        let store_id = store_id.trim();
        let mut entries = match store_id {
            SKILL_STORE_ID => self.skill_catalog(skills, refresh_remote).await?,
            ANBEIME_SKILL_STORE_ID => self.anbeime_skill_catalog(skills, refresh_remote).await?,
            MCP_STORE_ID => self.mcp_catalog(mcp, workspace_root).await?,
            _ => {
                return Err(AppError::configuration_not_found(format!(
                    "Extension store not found: {store_id}"
                )));
            }
        };
        if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
            let needle = query.to_ascii_lowercase();
            entries.retain(|entry| {
                entry.id.to_ascii_lowercase().contains(&needle)
                    || entry.name.to_ascii_lowercase().contains(&needle)
                    || entry.description.to_ascii_lowercase().contains(&needle)
                    || entry
                        .tags
                        .iter()
                        .any(|tag| tag.to_ascii_lowercase().contains(&needle))
            });
        }
        entries.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
        Ok(entries)
    }

    pub async fn install(
        &self,
        store_id: &str,
        entry_id: &str,
        env: BTreeMap<String, String>,
        enabled: Option<bool>,
        skills: &SkillService,
        mcp: &McpRepository,
        workspace_root: &Path,
    ) -> Result<ExtensionInstallResult, AppError> {
        let store_id = store_id.trim();
        let entry_id = entry_id.trim();
        if entry_id.is_empty() {
            return Err(AppError::invalid_request("entryId is required"));
        }
        match store_id {
            SKILL_STORE_ID => {
                let skill = self.install_skill(entry_id, skills).await?;
                Ok(ExtensionInstallResult::Skill { skill })
            }
            ANBEIME_SKILL_STORE_ID => {
                let skill = self.install_anbeime_skill(entry_id, skills).await?;
                Ok(ExtensionInstallResult::Skill { skill })
            }
            MCP_STORE_ID => {
                let server = self
                    .install_mcp(entry_id, env, enabled, mcp, workspace_root)
                    .await?;
                Ok(ExtensionInstallResult::Mcp { server })
            }
            _ => Err(AppError::configuration_not_found(format!(
                "Extension store not found: {store_id}"
            ))),
        }
    }

    pub async fn install_skill_from_github(
        &self,
        repo: &str,
        path: &str,
        r#ref: Option<&str>,
        skill_id: Option<&str>,
        skills: &SkillService,
    ) -> Result<SkillSummary, AppError> {
        let repo = validate_github_repo(repo)?;
        let path = validate_github_path(path)?;
        let git_ref = r#ref.unwrap_or("main").trim();
        if git_ref.is_empty() || git_ref.contains("..") || git_ref.contains('/') || git_ref.contains('\\') {
            // allow refs like main, master, v1.0.0 — reject path-like refs
            if git_ref.contains("..") || git_ref.contains('\\') {
                return Err(AppError::invalid_request("ref is invalid"));
            }
        }
        let id = skill_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_owned())
            .unwrap_or_else(|| {
                path.rsplit('/')
                    .next()
                    .unwrap_or("skill")
                    .to_owned()
            });
        validate_skill_id(&id)?;
        let content = download_github_skill_md(&repo, &path, git_ref).await?;
        skills.install(&id, &content)
    }

    async fn skill_catalog(
        &self,
        skills: &SkillService,
        refresh_remote: bool,
    ) -> Result<Vec<ExtensionCatalogEntry>, AppError> {
        let installed = skills.list().unwrap_or_default();
        let mut entries = Vec::new();
        for item in BUILTIN_SKILLS {
            let installed_flag = installed.iter().any(|skill| skill.id == item.id);
            entries.push(ExtensionCatalogEntry {
                id: item.id.to_owned(),
                store_id: SKILL_STORE_ID.to_owned(),
                kind: "skill".to_owned(),
                name: item.name.to_owned(),
                description: item.description.to_owned(),
                homepage: Some(item.homepage.to_owned()),
                tags: item.tags.iter().map(|value| (*value).to_owned()).collect(),
                installed: installed_flag,
                install: skill_install_value(&item.source),
                config: None,
            });
        }
        if refresh_remote {
            match list_github_skill_dirs("openai/skills", "skills/.curated", "main").await {
                Ok(remote) => {
                    for remote_skill in remote {
                        if entries.iter().any(|entry| entry.id == remote_skill.id) {
                            continue;
                        }
                        let installed_flag =
                            installed.iter().any(|skill| skill.id == remote_skill.id);
                        entries.push(ExtensionCatalogEntry {
                            id: remote_skill.id.clone(),
                            store_id: SKILL_STORE_ID.to_owned(),
                            kind: "skill".to_owned(),
                            name: remote_skill.name,
                            description: remote_skill.description,
                            homepage: Some(format!(
                                "https://github.com/openai/skills/tree/main/skills/.curated/{}",
                                remote_skill.id
                            )),
                            tags: vec!["openai".to_owned(), "curated".to_owned()],
                            installed: installed_flag,
                            install: json_github_install(
                                "openai/skills",
                                &format!("skills/.curated/{}", remote_skill.id),
                                "main",
                            ),
                            config: None,
                        });
                    }
                }
                Err(error) => {
                    // Remote refresh is best-effort; keep builtin catalog available.
                    let _ = error;
                }
            }
        }
        Ok(entries)
    }

    async fn mcp_catalog(
        &self,
        mcp: &McpRepository,
        workspace_root: &Path,
    ) -> Result<Vec<ExtensionCatalogEntry>, AppError> {
        let configured = mcp.list().await.unwrap_or_default();
        let mut entries = Vec::new();
        for item in BUILTIN_MCPS {
            let installed_flag = configured.iter().any(|server| server.name == item.name);
            let args = render_mcp_args(item.args, workspace_root);
            entries.push(ExtensionCatalogEntry {
                id: item.id.to_owned(),
                store_id: MCP_STORE_ID.to_owned(),
                kind: "mcp".to_owned(),
                name: item.name.to_owned(),
                description: item.description.to_owned(),
                homepage: Some(item.homepage.to_owned()),
                tags: item.tags.iter().map(|value| (*value).to_owned()).collect(),
                installed: installed_flag,
                install: serde_json::json!({
                    "type": "mcpStdio",
                    "command": item.command,
                    "args": args,
                    "envKeys": item.env_keys,
                    "defaultEnabled": item.default_enabled,
                }),
                config: Some(serde_json::json!({
                    "requiredEnv": item.env_keys,
                    "transport": "stdio",
                })),
            });
        }
        Ok(entries)
    }


    async fn anbeime_skill_catalog(
        &self,
        skills: &SkillService,
        refresh_remote: bool,
    ) -> Result<Vec<ExtensionCatalogEntry>, AppError> {
        let installed = skills.list().unwrap_or_default();
        let mut entries: Vec<ExtensionCatalogEntry> = Vec::new();
        let mut seen = std::collections::BTreeSet::new();

        for id in ANBEIME_PACKAGED_SKILLS {
            if !seen.insert((*id).to_owned()) {
                continue;
            }
            let installed_flag = installed.iter().any(|skill| skill.id == *id);
            entries.push(ExtensionCatalogEntry {
                id: (*id).to_owned(),
                store_id: ANBEIME_SKILL_STORE_ID.to_owned(),
                kind: "skill".to_owned(),
                name: humanize_skill_id(id),
                description: format!(
                    "Packaged skill from {ANBEIME_REPO}/{ANBEIME_SKILLS_PATH}/{id}"
                ),
                homepage: Some(format!(
                    "https://github.com/{ANBEIME_REPO}/tree/{ANBEIME_REF}/{ANBEIME_SKILLS_PATH}/{id}"
                )),
                tags: vec!["anbeime".to_owned(), "packaged".to_owned()],
                installed: installed_flag,
                install: json_github_install(
                    ANBEIME_REPO,
                    &format!("{ANBEIME_SKILLS_PATH}/{id}"),
                    ANBEIME_REF,
                ),
                config: None,
            });
        }

        if let Ok(remote_dirs) =
            list_github_skill_dirs(ANBEIME_REPO, ANBEIME_SKILLS_PATH, ANBEIME_REF).await
        {
            for remote in remote_dirs {
                if !seen.insert(remote.id.clone()) {
                    if let Some(entry) = entries.iter_mut().find(|item| item.id == remote.id) {
                        entry.name = remote.name;
                        entry.description = remote.description;
                    }
                    continue;
                }
                let installed_flag = installed.iter().any(|skill| skill.id == remote.id);
                entries.push(ExtensionCatalogEntry {
                    id: remote.id.clone(),
                    store_id: ANBEIME_SKILL_STORE_ID.to_owned(),
                    kind: "skill".to_owned(),
                    name: remote.name,
                    description: remote.description,
                    homepage: Some(format!(
                        "https://github.com/{ANBEIME_REPO}/tree/{ANBEIME_REF}/{ANBEIME_SKILLS_PATH}/{}",
                        remote.id
                    )),
                    tags: vec!["anbeime".to_owned(), "packaged".to_owned()],
                    installed: installed_flag,
                    install: json_github_install(
                        ANBEIME_REPO,
                        &format!("{ANBEIME_SKILLS_PATH}/{}", remote.id),
                        ANBEIME_REF,
                    ),
                    config: None,
                });
            }
        }

        if refresh_remote {
            if let Ok(remote_skills) = fetch_anbeime_skill_index().await {
                for remote in remote_skills {
                    if !seen.insert(remote.id.clone()) {
                        continue;
                    }
                    let installed_flag = installed.iter().any(|skill| skill.id == remote.id);
                    let mut tags = vec!["anbeime".to_owned(), "crawled".to_owned()];
                    if let Some(category) = remote.category.clone() {
                        tags.push(category);
                    }
                    entries.push(ExtensionCatalogEntry {
                        id: remote.id.clone(),
                        store_id: ANBEIME_SKILL_STORE_ID.to_owned(),
                        kind: "skill".to_owned(),
                        name: remote.name,
                        description: remote.description,
                        homepage: remote.homepage,
                        tags,
                        installed: installed_flag,
                        install: json_github_install(&remote.repo, &remote.path, &remote.git_ref),
                        config: None,
                    });
                }
            }
        }

        Ok(entries)
    }

    async fn install_anbeime_skill(
        &self,
        entry_id: &str,
        skills: &SkillService,
    ) -> Result<SkillSummary, AppError> {
        validate_skill_id(entry_id)?;

        let packaged_paths = [
            format!("{ANBEIME_SKILLS_PATH}/{entry_id}"),
            format!("{ANBEIME_SKILLS_PATH}/{entry_id}/{entry_id}"),
        ];
        for path in &packaged_paths {
            if let Ok(content) = download_github_skill_md(ANBEIME_REPO, path, ANBEIME_REF).await {
                return skills.install(entry_id, &content);
            }
        }

        if let Ok(remote_skills) = fetch_anbeime_skill_index().await {
            if let Some(remote) = remote_skills.into_iter().find(|item| item.id == entry_id) {
                let content =
                    download_github_skill_md(&remote.repo, &remote.path, &remote.git_ref).await?;
                return skills.install(entry_id, &content);
            }
        }

        Err(AppError::configuration_not_found(format!(
            "Anbeime catalog entry not found or SKILL.md missing: {entry_id}"
        )))
    }

    async fn install_skill(
        &self,
        entry_id: &str,
        skills: &SkillService,
    ) -> Result<SkillSummary, AppError> {
        let entry = BUILTIN_SKILLS
            .iter()
            .find(|item| item.id == entry_id)
            .ok_or_else(|| {
                // Allow installing remote curated ids discovered via refresh by treating
                // unknown ids as openai curated path when they look like skill ids.
                AppError::configuration_not_found(format!(
                    "Catalog entry not found: {entry_id}"
                ))
            });

        if let Ok(entry) = entry {
            return match &entry.source {
                BuiltinSkillSource::Inline { skill_md } => skills.install(entry.id, skill_md),
                BuiltinSkillSource::Github { repo, path, r#ref } => {
                    let content = download_github_skill_md(repo, path, r#ref).await?;
                    skills.install(entry.id, &content)
                }
            };
        }

        // Fallback: attempt openai curated install for unknown ids that passed validation.
        validate_skill_id(entry_id)?;
        let content = download_github_skill_md(
            "openai/skills",
            &format!("skills/.curated/{entry_id}"),
            "main",
        )
        .await
        .map_err(|_| {
            AppError::configuration_not_found(format!("Catalog entry not found: {entry_id}"))
        })?;
        skills.install(entry_id, &content)
    }

    async fn install_mcp(
        &self,
        entry_id: &str,
        env: BTreeMap<String, String>,
        enabled: Option<bool>,
        mcp: &McpRepository,
        workspace_root: &Path,
    ) -> Result<McpServer, AppError> {
        let entry = BUILTIN_MCPS
            .iter()
            .find(|item| item.id == entry_id)
            .ok_or_else(|| {
                AppError::configuration_not_found(format!("Catalog entry not found: {entry_id}"))
            })?;

        if mcp.list().await?.iter().any(|server| server.name == entry.name) {
            return Err(AppError::invalid_request(format!(
                "MCP server '{}' is already configured",
                entry.name
            )));
        }

        let mut final_env = BTreeMap::new();
        for key in entry.env_keys {
            match env.get(*key).map(|value| value.trim()).filter(|value| !value.is_empty()) {
                Some(value) => {
                    final_env.insert((*key).to_owned(), value.to_owned());
                }
                None => {
                    return Err(AppError::invalid_request(format!(
                        "Missing required env var: {key}"
                    )));
                }
            }
        }
        // Allow extra env passthrough for advanced configuration.
        for (key, value) in env {
            if !final_env.contains_key(&key) && !value.trim().is_empty() {
                final_env.insert(key, value);
            }
        }

        let enabled = enabled.unwrap_or(entry.default_enabled && entry.env_keys.is_empty());
        mcp.create(CreateMcpServerInput {
            name: entry.name.to_owned(),
            command: entry.command.to_owned(),
            args: render_mcp_args(entry.args, workspace_root),
            env: final_env,
            enabled,
        })
        .await
    }
}

#[derive(Debug)]
struct RemoteSkillSummary {
    id: String,
    name: String,
    description: String,
}

fn skill_install_value(source: &BuiltinSkillSource) -> Value {
    match source {
        BuiltinSkillSource::Inline { .. } => serde_json::json!({
            "type": "inline",
        }),
        BuiltinSkillSource::Github { repo, path, r#ref } => {
            json_github_install(repo, path, r#ref)
        }
    }
}

fn json_github_install(repo: &str, path: &str, r#ref: &str) -> Value {
    serde_json::json!({
        "type": "github",
        "repo": repo,
        "path": path,
        "ref": r#ref,
    })
}

fn render_mcp_args(args: &[&str], workspace_root: &Path) -> Vec<String> {
    let root = workspace_root.display().to_string();
    args.iter()
        .map(|arg| arg.replace("{{workspaceRoot}}", &root))
        .collect()
}

fn validate_skill_id(skill_id: &str) -> Result<(), AppError> {
    let skill_id = skill_id.trim();
    if skill_id.is_empty()
        || skill_id.len() > 64
        || skill_id.contains('/')
        || skill_id.contains('\\')
        || skill_id.contains("..")
        || !skill_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(AppError::invalid_request("skill id is invalid"));
    }
    Ok(())
}

fn validate_github_repo(repo: &str) -> Result<String, AppError> {
    let repo = repo.trim().trim_matches('/');
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || owner.is_empty()
        || name.is_empty()
        || !owner
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(AppError::invalid_request(
            "repo must look like owner/name",
        ));
    }
    Ok(format!("{owner}/{name}"))
}

fn validate_github_path(path: &str) -> Result<String, AppError> {
    let path = path.trim().trim_matches('/');
    if path.is_empty() || path.contains("..") || path.contains('\\') {
        return Err(AppError::invalid_request("path is invalid"));
    }
    if !path
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
    {
        return Err(AppError::invalid_request("path contains invalid characters"));
    }
    Ok(path.to_owned())
}

fn http_client() -> Result<Client, AppError> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|error| AppError::provider_request_failed(format!("HTTP client error: {error}")))
}

async fn download_github_skill_md(repo: &str, path: &str, git_ref: &str) -> Result<String, AppError> {
    let repo = validate_github_repo(repo)?;
    let path = validate_github_path(path)?;
    let git_ref = git_ref.trim();
    if git_ref.is_empty() || git_ref.contains("..") || git_ref.contains('\\') {
        return Err(AppError::invalid_request("ref is invalid"));
    }
    let url = format!("https://raw.githubusercontent.com/{repo}/{git_ref}/{path}/SKILL.md");
    ensure_allowed_url(&url)?;
    let client = http_client()?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| AppError::provider_request_failed(format!("Skill download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::provider_request_failed(format!(
            "Skill download failed with HTTP {}",
            response.status()
        )));
    }
    let content = response
        .text()
        .await
        .map_err(|error| AppError::provider_request_failed(format!("Skill download failed: {error}")))?;
    if content.trim().is_empty() || content.len() > 512 * 1024 {
        return Err(AppError::invalid_request("Downloaded SKILL.md is empty or too large"));
    }
    Ok(content)
}

async fn list_github_skill_dirs(
    repo: &str,
    path: &str,
    git_ref: &str,
) -> Result<Vec<RemoteSkillSummary>, AppError> {
    let repo = validate_github_repo(repo)?;
    let path = validate_github_path(path)?;
    let url = format!("https://api.github.com/repos/{repo}/contents/{path}?ref={git_ref}");
    ensure_allowed_url(&url)?;
    let client = http_client()?;
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            AppError::provider_request_failed(format!("Skill catalog refresh failed: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(AppError::provider_request_failed(format!(
            "Skill catalog refresh failed with HTTP {}",
            response.status()
        )));
    }
    let payload: Value = response.json().await.map_err(|error| {
        AppError::provider_request_failed(format!("Skill catalog refresh failed: {error}"))
    })?;
    let items = payload
        .as_array()
        .ok_or_else(|| AppError::provider_request_failed("Unexpected GitHub contents payload"))?;
    let mut skills = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("dir") {
            continue;
        }
        let id = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if validate_skill_id(id).is_err() {
            continue;
        }
        skills.push(RemoteSkillSummary {
            id: id.to_owned(),
            name: id.replace('-', " "),
            description: format!("Curated skill from {repo}/{path}/{id}"),
        });
    }
    Ok(skills)
}


#[derive(Debug)]
struct AnbeimeRemoteSkill {
    id: String,
    name: String,
    description: String,
    homepage: Option<String>,
    category: Option<String>,
    repo: String,
    path: String,
    git_ref: String,
}

fn humanize_skill_id(skill_id: &str) -> String {
    skill_id.replace('-', " ").replace('_', " ")
}

fn sanitize_catalog_id(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else if ch == '/' || ch == '.' || ch == ' ' {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if validate_skill_id(&cleaned).is_ok() {
        Some(cleaned)
    } else {
        None
    }
}

fn parse_github_tree_url(link: &str) -> Option<(String, String, String)> {
    let url = url::Url::parse(link).ok()?;
    if url.host_str() != Some("github.com") {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
    let owner = segments.next()?.to_owned();
    let repo_name = segments.next()?.to_owned();
    if segments.next()? != "tree" {
        return None;
    }
    let git_ref = segments.next()?.to_owned();
    let path = segments.collect::<Vec<_>>().join("/");
    if path.is_empty() {
        return None;
    }
    let repo = format!("{owner}/{repo_name}");
    validate_github_repo(&repo).ok()?;
    validate_github_path(&path).ok()?;
    if git_ref.contains("..") || git_ref.contains('\\') {
        return None;
    }
    Some((repo, path, git_ref))
}

async fn fetch_anbeime_skill_index() -> Result<Vec<AnbeimeRemoteSkill>, AppError> {
    let url = format!(
        "https://raw.githubusercontent.com/{ANBEIME_REPO}/{ANBEIME_REF}/{ANBEIME_INDEX_PATH}"
    );
    ensure_allowed_url(&url)?;
    let client = http_client()?;
    let response = client.get(&url).send().await.map_err(|error| {
        AppError::provider_request_failed(format!("Anbeime skill index download failed: {error}"))
    })?;
    if !response.status().is_success() {
        return Err(AppError::provider_request_failed(format!(
            "Anbeime skill index download failed with HTTP {}",
            response.status()
        )));
    }
    let payload: Value = response.json().await.map_err(|error| {
        AppError::provider_request_failed(format!("Anbeime skill index parse failed: {error}"))
    })?;
    let items = payload
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::provider_request_failed("Anbeime skill index missing skills[]"))?;
    let mut skills = Vec::new();
    for item in items {
        let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let link = item.get("link").and_then(Value::as_str).unwrap_or_default();
        let category = item
            .get("category")
            .and_then(Value::as_str)
            .map(|value| value.to_owned());
        let Some(id) = sanitize_catalog_id(name) else {
            continue;
        };
        let Some((repo, path, git_ref)) = parse_github_tree_url(link) else {
            continue;
        };
        let display_name = if name.trim().is_empty() {
            humanize_skill_id(&id)
        } else {
            name.to_owned()
        };
        skills.push(AnbeimeRemoteSkill {
            id,
            name: display_name,
            description: if description.is_empty() {
                format!("Crawled skill from {link}")
            } else {
                description
            },
            homepage: Some(link.to_owned()),
            category,
            repo,
            path,
            git_ref,
        });
    }
    Ok(skills)
}

fn ensure_allowed_url(raw: &str) -> Result<(), AppError> {
    let parsed = url::Url::parse(raw)
        .map_err(|error| AppError::invalid_request(format!("Invalid URL: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::invalid_request("Only https catalog URLs are allowed"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !matches!(
        host,
        "github.com" | "api.github.com" | "raw.githubusercontent.com"
    ) {
        return Err(AppError::invalid_request(format!(
            "Host not allowed for extension catalog: {host}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_github_tree_url, render_mcp_args, sanitize_catalog_id, validate_github_path,
        validate_github_repo, validate_skill_id, ANBEIME_PACKAGED_SKILLS,
    };
    use std::path::Path;

    #[test]
    fn validates_identifiers() {
        assert!(validate_skill_id("pr-review").is_ok());
        assert!(validate_skill_id("../x").is_err());
        assert!(validate_github_repo("openai/skills").is_ok());
        assert!(validate_github_repo("openai/skills/extra").is_err());
        assert!(validate_github_path("skills/.curated/demo").is_ok());
        assert!(validate_github_path("../etc/passwd").is_err());
    }

    #[test]
    fn parses_github_tree_and_sanitizes_anbeime_ids() {
        let parsed = parse_github_tree_url(
            "https://github.com/anthropics/skills/tree/main/skills/docx",
        )
        .expect("tree url");
        assert_eq!(parsed.0, "anthropics/skills");
        assert_eq!(parsed.1, "skills/docx");
        assert_eq!(parsed.2, "main");
        assert_eq!(
            sanitize_catalog_id("anthropics/docx").as_deref(),
            Some("anthropics-docx")
        );
        assert!(ANBEIME_PACKAGED_SKILLS.contains(&"frontend-design"));
        assert!(ANBEIME_PACKAGED_SKILLS.contains(&"content-creation-publisher"));
    }

    #[test]
    fn substitutes_workspace_root() {
        let args = render_mcp_args(
            &["-y", "@modelcontextprotocol/server-filesystem", "{{workspaceRoot}}"],
            Path::new("E:/workspace"),
        );
        assert_eq!(
            args,
            vec![
                "-y".to_owned(),
                "@modelcontextprotocol/server-filesystem".to_owned(),
                "E:/workspace".to_owned()
            ]
        );
    }
}
