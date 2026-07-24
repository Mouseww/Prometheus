from pathlib import Path

from playwright.sync_api import sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-foundation.png"
)


def assert_no_console_errors(errors: list[str]) -> None:
    if errors:
        raise AssertionError("Browser console errors:\n" + "\n".join(errors))


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

    first_page.goto("http://127.0.0.1:5173")
    first_page.wait_for_load_state("networkidle")
    first_page.get_by_text("README.md", exact=True).wait_for()

    first_page.locator("button.mini-button").click()
    first_page.get_by_placeholder("e.g. Ship authentication flow").fill(
        "Cross-device foundation verification"
    )
    first_page.locator(".modal-card").get_by_role("button", name="Create task").click()
    first_page.get_by_role("heading", name="Cross-device foundation verification").wait_for()

    second_page.goto("http://127.0.0.1:5173")
    second_page.wait_for_load_state("networkidle")
    second_page.get_by_role(
        "heading", name="Cross-device foundation verification"
    ).wait_for()

    first_page.locator("textarea").fill("Cross-device continuation verified.")
    first_page.get_by_role("button", name="Transmit").click()
    second_page.get_by_text("Cross-device continuation verified.", exact=True).wait_for(
        timeout=10_000
    )

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    first_page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert_no_console_errors(console_errors)

    print("workspace_tree=ok")
    print("session_create=ok")
    print("cross_device_websocket=ok")
    print(f"screenshot={SCREENSHOT}")
    browser.close()
