# Multi-line CriticMarkup Manual Test Document

This document contains various multi-line CriticMarkup patterns for manual testing.

## Test 1: Multi-line Addition

Here is a simple multi-line addition:

{++This is the first line of an addition.
This is the second line.
And this is the third line.++}

## Test 2: Multi-line Deletion

Here is a multi-line deletion:

{--This paragraph should be deleted.
It spans multiple lines.
All of these lines should be marked for deletion.--}

## Test 3: Multi-line Substitution

Here is a substitution with multi-line old and new text:

{~~The old text spans
multiple lines here.~>The new text also
spans multiple lines.~~}

## Test 4: Multi-line Comment

Here is a multi-line comment:

{>>This is a comment that provides
detailed feedback across multiple lines.
It can contain explanations and suggestions.<<}

## Test 5: Multi-line Highlight

Here is a multi-line highlight:

{==This important passage
spans multiple lines
and should be highlighted throughout.==}

## Test 6: Patterns with Empty Lines

### Addition with empty line
{++First paragraph of addition.

Second paragraph after empty line.++}

### Deletion with empty line
{--First paragraph to delete.

Second paragraph to delete.--}

### Substitution with empty lines
{~~Old text paragraph one.

Old text paragraph two.~>New text paragraph one.

New text paragraph two.~~}

### Comment with empty line
{>>First paragraph of comment.

Second paragraph of comment.<<}

### Highlight with empty line
{==First highlighted paragraph.

Second highlighted paragraph.==}

## Test 7: Empty Patterns

Empty addition: {++

++}

Empty deletion: {--

--}

## Test 8: Whitespace-only Patterns

Addition with spaces: {++   
   ++}

Deletion with tabs: {--		
		--}

## Test 9: Very Long Pattern (10+ lines)

{++Line 1 of a very long addition
Line 2 of the addition
Line 3 of the addition
Line 4 of the addition
Line 5 of the addition
Line 6 of the addition
Line 7 of the addition
Line 8 of the addition
Line 9 of the addition
Line 10 of the addition
Line 11 of the addition
Line 12 of the addition++}

## Test 10: Mixed Single and Multi-line

Single line addition: {++single line++}

Multi-line addition: {++first line
second line++}

Another single line: {--delete this--}

Another multi-line: {--delete first
delete second
delete third--}

## Test 11: Multiple Empty Lines

{++Paragraph one.


Paragraph two after two empty lines.++}

## Test 12: Complex Substitution

{~~Remove this entire section:
- Point one
- Point two
- Point three

And this conclusion.~>Replace with new section:
- New point A
- New point B

And new conclusion.~~}

## Test 13: Adjacent Patterns

{++Addition one++}{--Deletion one--}

{++Multi-line addition
spans two lines++}{==Multi-line highlight
also spans two lines==}

## Test 14: Pattern at Start of Document

{++This addition starts at the very beginning
and spans multiple lines.++}

## Test 15: Pattern at End of Document

This is the last test case.

{++This addition is at the very end
of the document
and spans multiple lines.++}
