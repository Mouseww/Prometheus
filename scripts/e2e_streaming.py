import json
import os
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-streaming.png"
)
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")
TASK_TITLE = "Cross-device streaming verification"
FINAL_REPLY = "Streaming fixture reply arrived on both terminals."


def get_json(path: str):
    with urllib.request.urlopen(f"{APP_URL}{path}", timeout=5) as response:
        return json.load(response)


def configure_runtime(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Streaming fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Streaming fixture"
    ).wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Streaming verifier")
    agent_form.get_by_label("Description").fill("Verifies live cross-device provider output")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Streaming verifier").wait_for(
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
    observer.evaluate("""() => {
        window.__prometheusStreamTexts = [];
        const capture = () => {
            const element = document.querySelector(
                '[aria-label="Streaming agent response"] .stream-text'
            );
            const text = element?.textContent ?? '';
            const seen = window.__prometheusStreamTexts;
            if (text && seen.at(-1) !== text) seen.push(text);
        };
        window.__prometheusStreamObserver = new MutationObserver(capture);
        window.__prometheusStreamObserver.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true,
        });
        capture();
    }""")

    primary.locator("textarea").fill("Stream a verified response.")
    primary.get_by_role("button", name="Transmit").click()

    observer_stream = observer.get_by_label("Streaming agent response")
    observer_stream.wait_for(timeout=10_000)
    observer_text = observer_stream.locator("p.stream-text")
    observer_text.wait_for(timeout=10_000)
    first_text = observer_text.text_content() or ""
    assert first_text
    assert len(first_text) < len(FINAL_REPLY)
    assert FINAL_REPLY.startswith(first_text)
    assert not observer.get_by_text(FINAL_REPLY, exact=True).is_visible()

    observer.wait_for_function(
        "() => window.__prometheusStreamTexts.length >= 2", timeout=10_000
    )
    seen_texts = observer.evaluate("() => window.__prometheusStreamTexts")
    grown_text = seen_texts[1]
    assert len(grown_text) > len(first_text)
    assert FINAL_REPLY.startswith(grown_text)

    observer_stream.wait_for(state="detached", timeout=15_000)
    primary.get_by_label("Streaming agent response").wait_for(
        state="detached", timeout=15_000
    )
    observer.get_by_text(FINAL_REPLY, exact=True).wait_for(timeout=15_000)
    primary.get_by_text(FINAL_REPLY, exact=True).wait_for(timeout=15_000)

    sessions = get_json("/api/sessions")["sessions"]
    session_id = next(session["id"] for session in sessions if session["title"] == TASK_TITLE)
    events = get_json(f"/api/sessions/{session_id}/events?afterSequence=0")["events"]
    agent_messages = [event for event in events if event["type"] == "message.agent"]
    assert len(agent_messages) == 1
    assert agent_messages[0]["payload"]["text"] == FINAL_REPLY
    assert not any(event["type"].startswith("run.stream") for event in events)

    observer.reload()
    observer.wait_for_load_state("networkidle")
    observer.get_by_role("heading", name=TASK_TITLE).wait_for()
    observer.get_by_text(FINAL_REPLY, exact=True).wait_for(timeout=10_000)
    assert observer.get_by_label("Streaming agent response").count() == 0

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    observer.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("cross_device_first_delta=ok")
    print("cross_device_stream_growth=ok")
    print("transient_draft_cleared=ok")
    print("single_durable_agent_message=ok")
    print("reload_from_sqlite=ok")
    print(f"screenshot={SCREENSHOT}")
    primary_context.close()
    observer_context.close()
    browser.close()
