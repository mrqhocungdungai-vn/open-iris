# PreToolCall input arrives as JSON on stdin. Exit 2 blocks the tool; stderr is the reason Iris gets.
cat > /dev/null
echo "key combos are off in this example" >&2
exit 2
