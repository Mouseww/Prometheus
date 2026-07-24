use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use prometheus_server::git_worktree_manager::GitWorktreeManager;
use tempfile::tempdir;
use uuid::Uuid;

#[test]
fn worktree_create_review_apply_cleanup_contract() {
    let fixture = create_repository();
    let manager =
        GitWorktreeManager::new(&fixture.workspace_root, &fixture.storage_root).expect("manager");
    let created = manager
        .create(&Uuid::new_v4().to_string(), "Builder")
        .expect("create");

    assert!(created.branch_name.starts_with("prometheus/team/"));
    assert_eq!(created.base_commit.len(), 40);
    assert!(
        created.worktree_root.exists(),
        "worktree root missing: {}",
        created.worktree_root.display()
    );
    assert_eq!(
        fs::read_to_string(created.workspace_root.join("base.txt")).expect("base"),
        "base\n"
    );

    fs::write(created.workspace_root.join("base.txt"), "changed\n").expect("write base");
    fs::write(created.workspace_root.join("new.txt"), "new\n").expect("write new");
    let review = manager
        .review(&created.worktree_root, &created.base_commit, &[".".into()])
        .expect("review");
    assert_eq!(review.status, "pending");
    assert!(review.changed_paths.contains(&"base.txt".into()));
    assert!(review.changed_paths.contains(&"new.txt".into()));
    assert!(review.disallowed_paths.is_empty());
    assert!(review.patch_bytes > 0);

    let applied = manager
        .apply(&created.worktree_root, &created.base_commit, &[".".into()])
        .expect("apply");
    assert_eq!(applied.status, "applied");
    assert_eq!(
        fs::read_to_string(fixture.workspace_root.join("base.txt")).expect("parent base"),
        "changed\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace_root.join("new.txt")).expect("parent new"),
        "new\n"
    );

    let cleaned = manager
        .cleanup(&created.worktree_root, &created.branch_name, "applied")
        .expect("cleanup");
    assert!(cleaned.removed);
    assert!(!created.worktree_root.exists());
}

#[test]
fn worktree_conflict_preserves_parent_and_child() {
    let fixture = create_repository();
    let manager =
        GitWorktreeManager::new(&fixture.workspace_root, &fixture.storage_root).expect("manager");
    let created = manager
        .create(&Uuid::new_v4().to_string(), "Conflicting")
        .expect("create");
    fs::write(created.workspace_root.join("base.txt"), "agent version\n").expect("child");
    fs::write(fixture.workspace_root.join("base.txt"), "parent version\n").expect("parent");

    let result = manager
        .apply(
            &created.worktree_root,
            &created.base_commit,
            &["base.txt".into()],
        )
        .expect("apply");
    assert_eq!(result.status, "conflicted");
    assert_eq!(result.conflict_paths, vec!["base.txt".to_owned()]);
    assert_eq!(
        fs::read_to_string(fixture.workspace_root.join("base.txt")).expect("parent"),
        "parent version\n"
    );
    assert_eq!(
        fs::read_to_string(created.workspace_root.join("base.txt")).expect("child"),
        "agent version\n"
    );
    assert!(created.worktree_root.exists());
}

#[test]
fn worktree_rejects_out_of_scope_paths() {
    let fixture = create_repository();
    let manager =
        GitWorktreeManager::new(&fixture.workspace_root, &fixture.storage_root).expect("manager");
    let created = manager
        .create(&Uuid::new_v4().to_string(), "Scoped")
        .expect("create");
    // Change file outside workspace relative scope by writing sibling under repo via worktree root.
    let repo_readme = created.worktree_root.join("README.md");
    fs::write(&repo_readme, "mutated\n").expect("readme");
    let review = manager
        .review(
            &created.worktree_root,
            &created.base_commit,
            &["base.txt".into()],
        )
        .expect("review");
    assert_eq!(review.status, "rejected");
    assert!(review.disallowed_paths.iter().any(|path| path.contains("README.md")));
}

struct RepoFixture {
    workspace_root: PathBuf,
    storage_root: PathBuf,
}

fn create_repository() -> RepoFixture {
    let root = tempdir().expect("temp");
    // Keep tempdir alive by leaking path into owned dirs under a persistent root.
    // tempfile cleanup on drop is fine for process lifetime of test.
    let root_path = root.keep();
    let repo_root = root_path.join("repo");
    let workspace_root = repo_root.join("packages").join("app");
    let storage_root = root_path.join("worktrees");
    fs::create_dir_all(&workspace_root).expect("workspace");
    fs::write(repo_root.join("README.md"), "repo\n").expect("readme");
    fs::write(workspace_root.join("base.txt"), "base\n").expect("base");
    git(&repo_root, &["init"]);
    git(&repo_root, &["config", "core.autocrlf", "false"]);
    git(&repo_root, &["config", "user.email", "prometheus-test@example.com"]);
    git(&repo_root, &["config", "user.name", "Prometheus Test"]);
    git(&repo_root, &["add", "."]);
    git(&repo_root, &["commit", "-m", "initial"]);
    RepoFixture {
        workspace_root,
        storage_root,
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    if !output.status.success() {
        panic!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
