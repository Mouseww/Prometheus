import json
import os
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-team-runtime.png"
)
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")
TASK_TITLE = "Parallel team runtime verification"
TEAM_GOAL = "Verify parallel team runtime"
RESEARCH_REPLY = "Research subagent completed with independent evidence."
REVIEW_REPLY = "Review subagent completed with independent evidence."


def get_json(path: str):
    with urllib.request.urlopen(f"{APP_URL}{path}", timeout=5) as response:
        return json.load(response)


def configure_runtime(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Team fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Team fixture"
    ).wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Research specialist")
    agent_form.get_by_label("Description").fill("Collects independent evidence")
    agent_form.get_by_label("System prompt").fill("Act as the research specialist.")
    agent_form.get_by_role("button", name="Save agent").click()

    agent_form.get_by_label("Name").fill("Review specialist")
    agent_form.get_by_label("Description").fill("Reviews evidence independently")
    agent_form.get_by_label("System prompt").fill("Act as the review specialist.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Research specialist").wait_for(
        state="attached"
    )
    page.locator(".agent-selector option", has_text="Review specialist").wait_for(
        state="attached"
    )


def create_task(page: Page) -> None:
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill(TASK_TITLE)
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.get_by_role("heading", name=TASK_TITLE).wait_for()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    primary_context = browser.new_context(viewport={"width": 1440, "height": 900})
    observer_context = browser.new_context(viewport={"width": 1180, "height": 820})
    primary = primary_context.new_page()
    observer = observer_context.new_page()
    console_errors: list[str] = []

    for page in (primary, observer):
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

    primary.goto(APP_URL)
    primary.wait_for_load_state("networkidle")
    configure_runtime(primary)
    create_task(primary)

    observer.goto(APP_URL)
    observer.wait_for_load_state("networkidle")
    observer.get_by_role("heading", name=TASK_TITLE).wait_for()
    observer.get_by_text("LIVE SYNC", exact=True).wait_for()

    primary.get_by_role("button", name="Team run", exact=True).click()
    primary.get_by_label("Team goal").fill(TEAM_GOAL)
    primary.get_by_label("Maximum concurrency").select_option("2")
    primary.get_by_role("button", name="Run 2 agents").click()

    summary = observer.get_by_label("Team run status")
    summary.wait_for(timeout=10_000)
    summary.get_by_text("Research specialist").wait_for(timeout=10_000)
    summary.get_by_text("Review specialist").wait_for(timeout=10_000)
    observer.wait_for_function(
        """() => {
            const statuses = [...document.querySelectorAll('[aria-label="Team run status"] .team-task small')]
                .map((node) => node.textContent);
            return statuses.length === 2 && statuses.every((status) => status?.startsWith('running ·'));
        }""",
        timeout=10_000,
    )
    observer.wait_for_function(
        "document.querySelectorAll('[aria-label=\"Streaming agent response\"]').length === 2",
        timeout=10_000,
    )

    observer.get_by_text(RESEARCH_REPLY, exact=True).wait_for(timeout=15_000)
    observer.get_by_text(REVIEW_REPLY, exact=True).wait_for(timeout=15_000)
    observer.wait_for_function(
        "document.querySelectorAll('[aria-label=\"Streaming agent response\"]').length === 0",
        timeout=15_000,
    )
    observer.wait_for_function(
        "document.querySelector('[aria-label=\"Team run status\"]')?.classList.contains('completed')",
        timeout=15_000,
    )

    sessions = get_json("/api/sessions")["sessions"]
    session_id = next(session["id"] for session in sessions if session["title"] == TASK_TITLE)
    teams = get_json(f"/api/sessions/{session_id}/team-runs")["teams"]
    assert len(teams) == 1
    team = teams[0]
    assert team["status"] == "completed"
    assert [task["status"] for task in team["tasks"]] == ["completed", "completed"]
    assert {task["output"] for task in team["tasks"]} == {RESEARCH_REPLY, REVIEW_REPLY}

    events = get_json(f"/api/sessions/{session_id}/events?afterSequence=0")["events"]
    assert len([event for event in events if event["type"] == "agent.spawned"]) == 2
    statuses = [event for event in events if event["type"] == "agent.status"]
    assert len([event for event in statuses if event["payload"]["status"] == "running"]) == 2
    assert len([event for event in statuses if event["payload"]["status"] == "completed"]) == 2
    agent_messages = [event for event in events if event["type"] == "message.agent"]
    assert len(agent_messages) == 2
    assert all(event["payload"]["isSubagent"] is True for event in agent_messages)
    assert {event["payload"]["text"] for event in agent_messages} == {
        RESEARCH_REPLY,
        REVIEW_REPLY,
    }
    assert not any(event["type"].startswith("run.stream") for event in events)

    observer.reload()
    observer.wait_for_load_state("networkidle")
    observer.get_by_role("heading", name=TASK_TITLE).wait_for()
    observer.get_by_text(RESEARCH_REPLY, exact=True).wait_for(timeout=10_000)
    observer.get_by_text(REVIEW_REPLY, exact=True).wait_for(timeout=10_000)
    reloaded_summary = observer.get_by_label("Team run status")
    reloaded_summary.wait_for(timeout=10_000)
    assert "completed" in (reloaded_summary.get_attribute("class") or "")
    assert observer.get_by_label("Streaming agent response").count() == 0

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    observer.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("parallel_subagent_streams=ok")
    print("durable_team_roster=ok")
    print("isolated_subagent_results=ok")
    print("cross_device_reload=ok")
    print(f"screenshot={SCREENSHOT}")
    primary_context.close()
    observer_context.close()
    browser.close()
