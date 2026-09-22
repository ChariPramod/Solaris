.PHONY: check test lint demo
PYTHON ?= python

check: lint test

lint:
	$(PYTHON) -m ruff check .
	$(PYTHON) -m ruff format --check .

test:
	$(PYTHON) -m pytest -q

demo:
	$(PYTHON) -m gauntlet run --dry-run --trials 3 --concurrency 2
