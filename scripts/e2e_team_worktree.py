import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-team-worktree.png"
)
WORKSPACE = Path(os.environ["PROMETHEUS_E2E_WORKSPACE"])
WORKTREE_ROOT = Path(os.environ["PROMETHEUS_E2E_WORKTREE_ROOT"])
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")
APPLY_GOAL = "Verify manual team worktree apply"
CONFLICT_GOAL = "Verify manual team worktree conflict"
APPLY_PATH = Path("src/team-note.txt")
CONFLICT_PATH = Path("src/shared.txt")
APPLY_CONTENT = "Prometheus team worktree apply verified.\n"
CONFLICT_CONTENT = "agent isolated version\n"


def get_json(path: str) -> dict:
    with urllib.request.urlopen(f"{APP_URL}{path}", timeout=5) as response:
        return json.load(response)


def wait_until(predicate, message: str, timeout: float = 20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError(message)


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=WORKSPACE,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def configure_runtime(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Team worktree fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Team worktree fixture"
    ).wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Worktree writer")
    agent_form.get_by_label("Description").fill("Edits only assigned paths in an isolated Git worktree")
    agent_form.get_by_label("System prompt").fill("Act as the worktree implementation specialist.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Worktree writer").wait_for(state="attached")


def create_task(page: Page) -> str:
    title = "Team worktree end-to-end verification"
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill(title)
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.get_by_role("heading", name=title).wait_for()
    sessions = get_json("/api/sessions")["sessions"]
    return next(session["id"] for session in sessions if session["title"] == title)


def launch_worktree_team(page: Page, goal: str) -> None:
    page.get_by_role("button", name="Team run", exact=True).click()
    page.get_by_label("Team goal").fill(goal)
    page.get_by_label("Workspace mode").select_option("worktree")
    page.get_by_label("Merge strategy").select_option("manual")
    page.locator(".team-path-assignments").get_by_role(
        "textbox", name="Worktree writer"
    ).fill("src")
    page.get_by_role("button", name="Run 1 agents").click()


def latest_team(session_id: str) -> dict:
    teams = get_json(f"/api/sessions/{session_id}/team-runs")["teams"]
    assert teams
    return teams[0]


def wait_for_change_status(session_id: str, goal: str, status: str) -> dict:
    def current():
        team = latest_team(session_id)
        if team["goal"] == goal and team["tasks"][0]["changeStatus"] == status:
            return team
        return None

    return wait_until(current, f"Team {goal!r} did not reach {status!r}")


def active_worktree() -> Path:
    def current():
        if not WORKTREE_ROOT.exists():
            return None
        children = [path for path in WORKTREE_ROOT.iterdir() if path.is_dir()]
        return children[0] if len(children) == 1 else None

    return wait_until(current, "Expected exactly one active isolated worktree")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    primary_context = browser.new_context(viewport={"width": 1440, "height": 900})
    reviewer_context = browser.new_context(viewport={"width": 1180, "height": 820})
    primary = primary_context.new_page()
    reviewer = reviewer_context.new_page()
    console_errors: list[str] = []
    for page in (primary, reviewer):
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

    primary.goto(APP_URL)
    primary.wait_for_load_state("networkidle")
    configure_runtime(primary)
    session_id = create_task(primary)

    reviewer.goto(APP_URL)
    reviewer.wait_for_load_state("networkidle")
    reviewer.get_by_text("LIVE SYNC", exact=True).wait_for()

    launch_worktree_team(primary, APPLY_GOAL)
    approve_apply = reviewer.get_by_role("button", name="Approve write to src/team-note.txt")
    approve_apply.wait_for(timeout=15_000)
    apply_worktree = active_worktree()
    assert not (WORKSPACE / APPLY_PATH).exists()
    assert not (apply_worktree / APPLY_PATH).exists()

    approve_apply.click()
    reviewer.get_by_text("Approved on a connected terminal", exact=True).wait_for(timeout=15_000)
    pending_team = wait_for_change_status(session_id, APPLY_GOAL, "pending")
    pending_task = pending_team["tasks"][0]
    assert pending_task["changedPaths"] == [APPLY_PATH.as_posix()]
    assert pending_task["patchBytes"] > 0
    assert not (WORKSPACE / APPLY_PATH).exists()
    assert (apply_worktree / APPLY_PATH).read_text(encoding="utf-8") == APPLY_CONTENT

    summary = reviewer.get_by_label("Team run status")
    summary.get_by_text("completed · pending", exact=True).wait_for(timeout=15_000)
    summary.get_by_label("Worktree writer changed paths").get_by_text(
        APPLY_PATH.as_posix(), exact=True
    ).wait_for()
    with reviewer.expect_response(
        lambda response: response.request.method == "POST" and response.url.endswith("/apply"),
        timeout=10_000,
    ) as apply_response_info:
        summary.get_by_role("button", name="Apply").click()
    apply_response = apply_response_info.value
    assert apply_response.status == 200, apply_response.text()
    applied_team = wait_for_change_status(session_id, APPLY_GOAL, "applied")
    applied_task = applied_team["tasks"][0]
    assert (WORKSPACE / APPLY_PATH).read_text(encoding="utf-8") == APPLY_CONTENT
    assert not apply_worktree.exists()
    assert applied_task["worktreeBranch"] not in git("branch", "--format=%(refname:short)").splitlines()

    reviewer.reload()
    reviewer.wait_for_load_state("networkidle")
    reloaded = reviewer.get_by_label("Team run status")
    reloaded.get_by_text("completed · applied", exact=True).wait_for(timeout=15_000)
    reloaded.get_by_label("Worktree writer changed paths").get_by_text(
        APPLY_PATH.as_posix(), exact=True
    ).wait_for()

    launch_worktree_team(primary, CONFLICT_GOAL)
    approve_conflict = reviewer.get_by_role("button", name="Approve write to src/shared.txt")
    approve_conflict.wait_for(timeout=15_000)
    conflict_worktree = active_worktree()
    assert (WORKSPACE / CONFLICT_PATH).read_text(encoding="utf-8") == "base shared\n"
    assert (conflict_worktree / CONFLICT_PATH).read_text(encoding="utf-8") == "base shared\n"

    (WORKSPACE / CONFLICT_PATH).write_text("parent changed\n", encoding="utf-8")
    approve_conflict.click()
    pending_conflict = wait_for_change_status(session_id, CONFLICT_GOAL, "pending")
    assert pending_conflict["tasks"][0]["changedPaths"] == [CONFLICT_PATH.as_posix()]
    assert (conflict_worktree / CONFLICT_PATH).read_text(encoding="utf-8") == CONFLICT_CONTENT

    conflict_summary = reviewer.get_by_label("Team run status")
    conflict_summary.get_by_text("completed · pending", exact=True).wait_for(timeout=15_000)
    with reviewer.expect_response(
        lambda response: response.request.method == "POST" and response.url.endswith("/apply"),
        timeout=10_000,
    ) as conflict_response_info:
        conflict_summary.get_by_role("button", name="Apply").click()
    conflict_response = conflict_response_info.value
    assert conflict_response.status == 200, conflict_response.text()
    conflicted_team = wait_for_change_status(session_id, CONFLICT_GOAL, "conflicted")
    conflicted_task = conflicted_team["tasks"][0]
    assert conflicted_task["conflictPaths"] == [CONFLICT_PATH.as_posix()]
    assert (WORKSPACE / CONFLICT_PATH).read_text(encoding="utf-8") == "parent changed\n"
    assert (conflict_worktree / CONFLICT_PATH).read_text(encoding="utf-8") == CONFLICT_CONTENT
    assert conflict_worktree.exists()
    assert conflicted_task["worktreeBranch"] in git("branch", "--format=%(refname:short)").splitlines()
    conflict_summary.get_by_text("completed · conflicted", exact=True).wait_for(timeout=15_000)
    conflict_summary.get_by_text("conflicts: src/shared.txt", exact=True).wait_for()

    events = get_json(f"/api/sessions/{session_id}/events?afterSequence=0")["events"]
    event_types = [event["type"] for event in events]
    assert event_types.count("team.workspace.created") == 2
    assert event_types.count("team.changes.detected") == 2
    assert "team.changes.applied" in event_types
    assert "team.changes.conflicted" in event_types
    assert "team.workspace.cleaned" in event_types

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    reviewer.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("worktree_write_requires_cross_device_approval=ok")
    print("manual_patch_preserves_parent_until_apply=ok")
    print("apply_updates_parent_and_cleans_branch=ok")
    print("durable_metadata_survives_reload=ok")
    print("conflict_preserves_parent_and_worktree=ok")
    print(f"screenshot={SCREENSHOT}")
    primary_context.close()
    reviewer_context.close()
    browser.close()
