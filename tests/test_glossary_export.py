"""Test glossary export and download functionality."""
import os
import sys

# Import the templates to check for HTML content
GLOSSARY_TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    'templates', 'admin', 'glossary.html'
)


def test_glossary_html_contains_download_buttons():
    """Verify glossary.html contains the download button implementations."""
    with open(GLOSSARY_TEMPLATE_PATH, 'r') as f:
        html = f.read()

    # Verify downloadAllChanges button is in the HTML (two places: dashboard and history)
    assert html.count('downloadAllChanges()') >= 2, "downloadAllChanges function call not found in glossary.html"

    # Verify the function is defined
    assert 'function downloadAllChanges()' in html, "downloadAllChanges function definition not found"

    # Verify downloadBatchExcel button is in the HTML
    assert 'downloadBatchExcel' in html, "downloadBatchExcel function not found in glossary.html"

    # Verify the function is defined
    assert 'function downloadBatchExcel(batchId)' in html, "downloadBatchExcel function definition not found"

    # Verify the endpoints are referenced
    assert '/prionvault/api/glossary/export-all-changes' in html, "export-all-changes endpoint not referenced"
    assert '/prionvault/api/glossary/batch-export/' in html, "batch-export endpoint not referenced"


def test_glossary_routes_endpoints_exist():
    """Verify that glossary route endpoints are defined."""
    import importlib.util

    routes_path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        'tools', 'prionvault', 'routes_glossary.py'
    )

    # Read the routes file to verify endpoints
    with open(routes_path, 'r') as f:
        routes_code = f.read()

    # Verify the endpoints are defined
    assert '@prionvault_bp.route("/api/glossary/export-all-changes"' in routes_code, \
        "export-all-changes endpoint not found in routes_glossary.py"

    assert '@prionvault_bp.route("/api/glossary/batch-export/' in routes_code, \
        "batch-export endpoint not found in routes_glossary.py"

    # Verify they require admin
    assert '@admin_required' in routes_code, "Routes don't have @admin_required decorator"
