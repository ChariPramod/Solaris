import json

from gauntlet.fixtures.apps import create_app
from gauntlet.fixtures.data import ADDRESS, CONTACT, SIGNUP, seed
from gauntlet.models import load_tasks
from gauntlet.verifiers.state import inspect_state, inventory


def test_forms_match_real_task_verifiers(tmp_path):
    seed(tmp_path)
    before = inventory(tmp_path / "docs")
    client = create_app(tmp_path).test_client()
    assert client.post("/contact", data=CONTACT).status_code == 200
    assert client.post("/signup", data={k: SIGNUP[k] for k in ("name", "email")}).status_code == 302
    assert (
        client.post("/signup/details", data={k: SIGNUP[k] for k in ("company", "role")}).status_code
        == 200
    )
    assert client.post("/shop", data={"Blue Notebook": 1, "Pencil Pack": 2}).status_code == 302
    assert client.post("/checkout", data=ADDRESS).status_code == 302
    assert not (tmp_path / "out/order.json").exists()
    assert client.post("/checkout/review").status_code == 200
    for task in load_tasks("T05,T06,T07"):
        assert inspect_state(tmp_path, task.verifier, before, {})["passed"]


def test_sessions_are_isolated(tmp_path):
    app = create_app(tmp_path)
    first, second = app.test_client(), app.test_client()
    first.post("/signup", data={"name": "Maria", "email": "maria@example.com"})
    assert second.get("/signup/details").status_code == 302
    assert second.post("/checkout/review").status_code == 302


def test_portal_requires_login_and_crossapp_answer(tmp_path):
    seed(tmp_path)
    portal = create_app(tmp_path, portal=True).test_client()
    assert portal.get("/dashboard").status_code == 302
    portal.post("/", data={"username": "researcher", "password": "wrong"})
    assert portal.get("/dashboard").status_code == 302
    portal.post("/", data={"username": "researcher", "password": "pine-demo-2026"})
    assert b"1274.50" in portal.get("/dashboard").data
    create_app(tmp_path).test_client().post("/reimburse", data={"amount": "1274.50"})
    assert json.loads((tmp_path / "out/reimburse.json").read_text()) == {"amount": "1274.50"}


def test_distractions_are_opt_in(tmp_path):
    plain = create_app(tmp_path).test_client()
    assert b"SYSTEM NOTICE" not in plain.get("/about").data
    assert b"setTimeout" not in plain.get("/contact").data
    altered = create_app(tmp_path, injection=True, popup=True).test_client()
    assert b"SYSTEM NOTICE" in altered.get("/about").data
    assert b"8000)" in altered.get("/contact").data


def test_invalid_checkout_is_rejected(tmp_path):
    client = create_app(tmp_path).test_client()
    assert client.post("/shop", data={"Blue Notebook": "-1"}).status_code == 400
    assert client.post("/shop", data={"Blue Notebook": "bad"}).status_code == 400
    assert not (tmp_path / "out/order.json").exists()


def test_t11_download_is_a_deterministic_archive_with_readable_pdf(tmp_path):
    import io
    import zipfile

    from pypdf import PdfReader

    client = create_app(tmp_path, portal=True).test_client()
    page = client.get("/downloads")
    assert page.status_code == 200
    assert b"/downloads/invoices.zip" in page.data
    response = client.get("/downloads/invoices.zip")
    assert response.status_code == 200
    assert response.mimetype == "application/zip"
    assert "attachment" in response.headers["Content-Disposition"]
    assert response.data == client.get("/downloads/invoices.zip").data
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        assert archive.namelist() == ["invoice.pdf"]
        reader = PdfReader(io.BytesIO(archive.read("invoice.pdf")))
    assert len(reader.pages) == 1
    text = reader.pages[0].extract_text()
    assert load_tasks("T11")[0].verifier["expected"] in text
    assert "1,274.50" in text
    assert "Fictional invoice" in text


def test_portal_navigation_uses_portal_routes(tmp_path):
    page = create_app(tmp_path, portal=True).test_client().get("/")
    assert b'href="/downloads"' in page.data
    assert b'href="/contact"' not in page.data
    assert b'type="password"' in page.data
