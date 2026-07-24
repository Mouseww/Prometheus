import json
import os
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-autonomous-team.png"
)
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")
TASK_TITLE = "Autonomous team communication verification"
USER_REQUEST = "Autonomously verify team communication."
RESEARCH_REPLY = "Research agent shared durable evidence."
REVIEW_REPLY = "Review agent consumed the shared message."
COORDINATOR_REPLY = "Coordinator verified autonomous delegation and durable Agent communication."


def get_json(path: str):
    with urllib.request.urlopen(f"{APP_URL}{path}", timeout=5) as response:
        return json.load(response)


def configure_runtime(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Autonomous team fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Autonomous team fixture"
    ).wait_for(state="attached")
    agents = [
        (
            "Autonomous coordinator",
            "Delegates bounded work and synthesizes results",
            "Act as the autonomous coordinator.",
        ),
        (
            "Communicating researcher",
            "Publishes evidence through the durable message bus",
            "Act as the communicating research specialist.",
        ),
        (
            "Communicating reviewer",
            "Consumes another Agent's durable evidence",
            "Act as the communicating review specialist.",
        ),
    ]
    configured_count = agent_form.locator(".runtime-form-title small")
    for index, (name, description, prompt) in enumerate(agents, start=1):
        agent_form.get_by_label("Name").fill(name)
        agent_form.get_by_label("Description").fill(description)
        agent_form.get_by_label("System prompt").fill(prompt)
        agent_form.get_by_role("button", name="Save agent").click()
        expect(configured_count).to_have_text(f"{index} configured", timeout=10_000)

    page.locator(".runtime-modal-header .icon-button").click()
    selector = page.locator(".agent-selector select")
    selector.locator("option", has_text="Autonomous coordinator").wait_for(state="attached")
    selector.select_option(label="Autonomous coordinator")


def create_task(page: Page) -> None:
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill(TASK_TITLE)
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.get_by_role("heading", name=TASK_TITLE).wait_for()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    primary_context = browser.new_context(viewport={"width": 1440, "height": 960})
    observer_context = browser.new_context(viewport={"width": 1280, "height": 900})
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

    primary.locator("textarea").fill(USER_REQUEST)
    primary.get_by_role("button", name="Transmit").click()

    summary = observer.get_by_label("Team run status")
    summary.wait_for(timeout=15_000)
    observer.get_by_label("Agent message bus").wait_for(timeout=15_000)
    observer.get_by_text("Autonomous evidence", exact=True).wait_for(timeout=15_000)
    observer.get_by_text("Research agent shared durable evidence.", exact=True).first.wait_for(
        timeout=15_000
    )
    observer.get_by_text(REVIEW_REPLY, exact=True).wait_for(timeout=20_000)
    observer.get_by_text(COORDINATOR_REPLY, exact=True).wait_for(timeout=20_000)
    observer.wait_for_function(
        "document.querySelector('[aria-label=\"Team run status\"]')?.classList.contains('completed')",
        timeout=20_000,
    )

    sessions = get_json("/api/sessions")["sessions"]
    session_id = next(session["id"] for session in sessions if session["title"] == TASK_TITLE)
    teams = get_json(f"/api/sessions/{session_id}/team-runs")["teams"]
    assert len(teams) == 1
    team = teams[0]
    assert team["status"] == "completed"
    assert {task["output"] for task in team["tasks"]} == {RESEARCH_REPLY, REVIEW_REPLY}

    messages = get_json(f"/api/team-runs/{team['id']}/messages?afterSequence=0")["messages"]
    assert len(messages) == 1
    assert messages[0]["channel"] == "decision"
    assert messages[0]["recipientId"] == "*"
    assert messages[0]["subject"] == "Autonomous evidence"
    assert messages[0]["body"] == RESEARCH_REPLY
    assert messages[0]["sourceToolCallId"] == "fixture-send-team-message"

    events = get_json(f"/api/sessions/{session_id}/events?afterSequence=0")["events"]
    delegate_starts = [
        event for event in events
        if event["type"] == "tool.call.started" and event["payload"].get("toolName") == "delegate_team"
    ]
    delegate_completions = [
        event for event in events
        if event["type"] == "tool.call.completed" and event["payload"].get("toolName") == "delegate_team"
    ]
    assert len(delegate_starts) == 1
    assert len(delegate_completions) == 1
    assert len([event for event in events if event["type"] == "agent.message"]) == 1
    assert len([event for event in events if event["type"] == "agent.spawned"]) == 2
    agent_messages = [event for event in events if event["type"] == "message.agent"]
    assert len([event for event in agent_messages if event["payload"].get("isSubagent") is True]) == 2
    assert len([event for event in agent_messages if event["payload"].get("isSubagent") is not True]) == 1
    assert agent_messages[-1]["payload"]["text"] == COORDINATOR_REPLY
    assert not any(event["type"].startswith("run.stream") for event in events)

    observer.reload()
    observer.wait_for_load_state("networkidle")
    observer.get_by_role("heading", name=TASK_TITLE).wait_for()
    observer.get_by_label("Agent message bus").wait_for(timeout=10_000)
    observer.get_by_text("Autonomous evidence", exact=True).wait_for(timeout=10_000)
    observer.get_by_text(COORDINATOR_REPLY, exact=True).wait_for(timeout=10_000)

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    observer.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("model_initiated_delegation=ok")
    print("durable_agent_message_bus=ok")
    print("subagent_recursion_blocked=ok")
    print("cross_device_bus_reload=ok")
    print(f"screenshot={SCREENSHOT}")
    primary_context.close()
    observer_context.close()
    browser.close()
