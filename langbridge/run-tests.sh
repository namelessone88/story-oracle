#!/usr/bin/env sh
# LangBridge test runner. No build step, no test framework.
#
#   sh langbridge/run-tests.sh
#
# The DOM suite needs jsdom. Either `npm i jsdom` somewhere on the resolution
# path, or point LB_JSDOM at a node_modules directory that contains it:
#   LB_JSDOM=/path/to/node_modules sh langbridge/run-tests.sh
# Without jsdom the DOM suite skips (it never fails the run for being absent).

set -e
DIR=$(dirname "$0")
status=0

for suite in core sample setup pass dom; do
    printf '\n=== %s ===\n' "$suite"
    node "$DIR/test/$suite.test.mjs" || status=1
done

printf '\n'
[ "$status" -eq 0 ] && echo "ALL SUITES PASSED" || echo "SUITE FAILURES — see above"
exit "$status"
