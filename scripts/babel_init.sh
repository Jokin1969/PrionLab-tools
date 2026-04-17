#!/usr/bin/env bash
# Run from the project root to (re)generate and compile translations.
set -e

pybabel extract -F babel.cfg -o messages.pot .
pybabel update -i messages.pot -d translations -l es
pybabel update -i messages.pot -d translations -l en
pybabel compile -d translations

echo "Done. Edit translations/*/LC_MESSAGES/messages.po then rerun to recompile."
