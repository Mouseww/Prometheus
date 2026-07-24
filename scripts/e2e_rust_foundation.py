from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4310"
SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-rust-foundation.png"
)


def assert_no_unexpected_console_errors(errors: list[str]) -> None:
    # Rust 4A intentionally returns 501 for unmigrated Agent/Tool/Team runtime routes.
    unexpected = [
        error
        for error in errors
        if "status of 501" not in error and "runtime_not_migrated" not in error
    ]
    if unexpected:
        raise AssertionError("Browser console errors:\n" + "\n".join(unexpected))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    first_context = browser.new_context(viewport={"width": 1440, "height": 900})
    second_context = browser.new_context(viewport={"width": 1180, "height": 800})
    first_page = first_context.new_page()
    second_page = second_context.new_page()
    console_errors: list[str] = []

    for page in (first_page, second_page):
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

    first_page.goto(BASE)
    first_page.wait_for_load_state("networkidle")
    first_page.get_by_text("README.md", exact=True).wait_for()

    first_page.get_by_role("button", name="Configure runtime").click()
    first_page.get_by_role("heading", name="Connect real model providers").wait_for()

    provider_form = first_page.locator("form.runtime-form").filter(has_text="Save provider")
    provider_form.locator("select").first.select_option("openai_compatible")
    provider_form.get_by_placeholder("Team OpenAI").fill("Rust E2E Provider")
    provider_form.get_by_placeholder("https://api.example.com/v1").fill("https://api.example.com/v1")
    provider_form.get_by_placeholder("Provider model ID").fill("gpt-e2e")
    provider_form.get_by_placeholder("Encrypted before storage").fill("sk-e2e-secret")
    provider_form.get_by_role("button", name="Save provider").click()
    provider_form.get_by_text("1 configured").wait_for()

    agent_form = first_page.locator("form.runtime-form").filter(has_text="Save agent")
    agent_form.locator("select").select_option(label="Rust E2E Provider")
    agent_form.get_by_placeholder("Builder").fill("Rust E2E Agent")
    agent_form.get_by_placeholder("Define role, constraints and expected evidence.").fill(
        "You are a careful coding agent."
    )
    agent_form.get_by_role("button", name="Save agent").click()
    agent_form.get_by_text("1 configured").wait_for()

    first_page.get_by_label("Permission pattern").fill("pnpm test*")
    first_page.get_by_role("button", name="Add rule").click()
    first_page.locator("code").filter(has_text="pnpm test*").wait_for()
    first_page.locator(".runtime-modal-header .icon-button").click()

    first_page.locator("button.mini-button").click()
    first_page.get_by_placeholder("e.g. Ship authentication flow").fill("Rust foundation verification")
    first_page.locator(".modal-card").get_by_role("button", name="Create task").click()
    first_page.get_by_role("heading", name="Rust foundation verification").wait_for()

    second_page.goto(BASE)
    second_page.wait_for_load_state("networkidle")
    second_page.get_by_role("heading", name="Rust foundation verification").wait_for()

    first_page.locator("textarea").fill("Cross-device continuation via Rust control plane.")
    first_page.get_by_role("button", name="Transmit").click()
    second_page.get_by_text("Cross-device continuation via Rust control plane.", exact=True).wait_for(
        timeout=10_000
    )

    second_page.reload()
    second_page.wait_for_load_state("networkidle")
    second_page.get_by_role("heading", name="Rust foundation verification").wait_for()
    second_page.get_by_text("Cross-device continuation via Rust control plane.", exact=True).wait_for()
    second_page.get_by_role("button", name="Configure runtime").click()
    second_page.locator("form.runtime-form").filter(has_text="Save provider").get_by_text("1 configured").wait_for()
    second_page.locator("form.runtime-form").filter(has_text="Save agent").get_by_text("1 configured").wait_for()
    second_page.locator("form.runtime-form").filter(has_text="Save agent").locator(
        "option", has_text="Rust E2E Provider"
    ).wait_for(state="attached")
    second_page.locator("code").filter(has_text="pnpm test*").wait_for()

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    first_page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert_no_unexpected_console_errors(console_errors)

    print("workspace_tree=ok")
    print("runtime_config=ok")
    print("session_create=ok")
    print("cross_device_websocket=ok")
    print("reload_persistence=ok")
    print(f"screenshot={SCREENSHOT}")
    browser.close()
