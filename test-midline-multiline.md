# Test Mid-line Multi-line Patterns

## Test 1: Pattern starting at beginning of line (should work)
{++This is an addition
that spans multiple lines++}

## Test 2: Pattern starting mid-line (reported as broken)
This is some text {++and here is an addition
that spans multiple lines++} and continues.

## Test 3: Single-line mid-line pattern (should work)
This is some text {++inline addition++} and continues.
