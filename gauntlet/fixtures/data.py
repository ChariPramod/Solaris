"""Public task inputs, shared by the fixture server and setup."""

from pathlib import Path

TITLE = "Welcome to Solari Research"
SIGNUP = {
    "name": "Maria Chen",
    "email": "maria@example.com",
    "company": "Pinetree",
    "role": "Researcher",
}
ADDRESS = {"street": "123 Pine Street", "city": "San Francisco", "postcode": "94107"}
CONTACT = {"name": "Pramod Test", "email": "test@example.com", "message": "Hello from the harness"}
MARCH_TOTAL = "1274.50"
SALES = [120, 85, 210, 95, 160, 135, 180, 75, 225, 115]

FILES = {
    "draft_report.txt": "Pinetree Research\nQuarterly reliability report.\n",
    "contacts.txt": "Alex Rivera: 415-555-0101\nMaria Chen: 415-555-0142\nJo Lee: 415-555-0183\n",
    "signup_details.txt": "\n".join(f"{k}: {v}" for k, v in SIGNUP.items()) + "\n",
    "address.txt": "\n".join(f"{k}: {v}" for k, v in ADDRESS.items()) + "\n",
    "creds.txt": "Username: researcher\nPassword: pine-demo-2026\n",
    "sales.csv": "Day,Sales\n" + "".join(f"{day},{value}\n" for day, value in enumerate(SALES, 1)),
}


def seed(root: Path) -> None:
    (root / "docs").mkdir(parents=True, exist_ok=True)
    (root / "out").mkdir(parents=True, exist_ok=True)
    for name, content in FILES.items():
        (root / "docs" / name).write_text(content)
