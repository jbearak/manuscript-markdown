# LaTeX Equations

This is a quick reference for writing LaTeX equations in Manuscript Markdown. Equations are converted to Word's native equation format on export and back to LaTeX on import — see [DOCX Converter](converter.md#latex-equations) for converter details.

## Inline and Display Math

Wrap equations in dollar signs:

- **Inline**: `$E = mc^2$` — renders within the text flow
- **Display**: `$$E = mc^2$$` — renders as a centered block equation
- **Bare environments**: `\begin{align}...\end{align}` — treated as `$$\begin{align}...\end{align}$$`

Display math is part of a paragraph, so a line in it that would start a Markdown block ends the paragraph and the equation, as in CommonMark. Such a line starts with a code fence (```` ``` ```` or `~~~`), a list marker (`-`, `+` or `*`, or `1.`, and a space and text), a `#` heading, a `>` quote, a rule such as `---`, an HTML block's tag such as `<div>`, or a table's header row, such as `|b|`, right before its delimiter row, such as `|-|`. A line of `~~~` nonbreaking spaces, or an aligned row such as `~~~ &= 2`, opens a code block that runs to the end of the document. Indent such a line by four spaces or more: it then continues the paragraph, and LaTeX ignores the indentation. Import indents such a line of an equation from Word by four spaces, so it stays one equation on the next export. A line that starts no block there, as a row of bars before no delimiter row, `2. b` or a line of one tag such as `<x>`, stays as it is. So does each line of an equation in a tracked change, whose span export reads as one line. Pandoc's Markdown differs: it needs a blank line before a fenced code block, a heading, a quote or a list, so there such a line stays in the equation. The indented line reads the same in both.

```latex
\begin{align}
  x &= 1 \\
    ~~~ &= 2
\end{align}
```

A heading can't go past its line, so display math that's all of a heading goes on that line, as in `# $$y = x$$`. Word gets the equation in the heading's paragraph. Import writes it back on the heading's line, as `$$...$$`, where its LaTeX holds no line end, no `$` and no `%` comment, and the equation as a whole isn't highlighted, commented or in a tracked change. A tracked change inside its LaTeX is fine. Any other display equation in a heading, as one with text beside it, as in `# Model: $$y = x$$`, comes back after the heading, on lines of its own, and the next export gives it a paragraph of its own. The heading comes back without the spaces and tabs before the equation, which Word shows nothing for at the end of the heading's line, and which Markdown would drop from the heading.

A list item's or a quote's text that starts with an HTML comment, before a display equation in its paragraph, as Word has a comment that started a heading in a list item, is an HTML block of its own line to Markdown, which ends there. So the equation comes back after a blank line, as a paragraph of its own, which Word gets after the next export. So does a paragraph's, where text follows the comment on its line. A paragraph's comments alone keep the equation on the next line, as export keeps the blank lines after them.

Inline math right after a display equation in a paragraph, or in a note, as Word can have it, comes back on the line after the equation's closing fence, as a display equation right after one does. On the fence's line, its `$` would run into the fence and read as text. Export reads that line end as a space, as it does the line end before an opening fence, so Word gets a space between the equations. Where line ends are line breaks (`breaks: true`), that line end would be a line break in Word, so import keeps the inline math on the fence's line there, as before. A grid table's cell reads every line end as a line break, so import keeps the inline math on the fence's line in a cell too, as before.

A tracked change, a highlight or a comment around display math alone, as import writes one, keeps the equation in its paragraph, with text before or after it there, as display math in none is kept. Word gets the change, the highlight or the comment on the equation there. A highlight with a comment over it, or with a comment right after it in its paragraph, comes back without the highlight, as before, since `{==...==}{>>...<<}` reads as a comment over the equation. A span with a blank line between its equations still puts each in a paragraph of its own. In a heading, the equation goes in a paragraph of its own after the heading's, as above. Inline math right after such a span stays on the span's closing line, as `++}`, `--}` or `==}` keeps it apart from the fence.

The preview shows text after a display equation's closing fence on the fence's line, as in `$$&#32;b.`, after the equation, as it shows text on the line after the fence, and in one paragraph with the lines after it that go on in the equation's paragraph. VS Code's math extension ends the equation at that fence and would leave the rest of the line out. Word gets that text, and those lines, in the equation's paragraph. A `$` right after the fence shows as text, as export reads it; after a space, it opens inline math.

### Tracked changes inside inline equations

CriticMarkup can wrap a changed fragment inside an inline equation. Keep each
changed side as a self-contained LaTeX fragment:

```markdown
$u_j^2{+++\tau_{g_j}^2++}$
$a{~~+b~>+c~~}$
```

The first example marks `+\tau_{g_j}^2` as an addition. The second marks `+b`
as deleted and `+c` as inserted. These fragments render as equation content in
the preview and become tracked math revisions when exported to Word. A change
ends in the equation it opens in, where the equation ends in its paragraph and
no other markup comes before it there (see [CriticMarkup](criticmarkup.md)):
the `{++` of `$x^{++}$` is the superscript's, and no `++}` after the closing
`$` ends it. A change
of only whitespace, as in `$a{++ ++}b$`, keeps its whitespace in Word, so Word
keeps the change. The whitespace around a command, as in
`$a{++ \quad ++}b$`, is the source's, which Word ignores, as LaTeX does. Where
Word has no form for the command, as in `$a{++ \! ++}b$`, Word shows no change,
and the change doesn't come back on import.

A highlight works inside an inline equation too, in a fraction or script as
well, as in `$a{==b==}c$` or `$\frac{a}{{==b==}}$`. Word gets one equation
with the highlighted part's runs highlighted. Word's highlight on
part of an equation comes back in `{==...==}` where it's at the top level of
an inline equation, as on `b` or on all of `\frac{b}{c}` in
`$a{==\frac{b}{c}==}d$`. One inside a structure, as on the denominator alone,
doesn't come back: the preview renders an inline equation in pieces at
CriticMarkup, and a piece of a fraction, as `\frac{a}{`, isn't an equation it
can render. Nor does one on an equation array, whose equation numbers it
would hold. A highlight on all of an
equation's content is on the equation, as Word holds it: `${==abc==}$` comes
back as `==$abc$==`. A highlight inside an equation takes no color, so Word's
in a color other than yellow doesn't come back. Nor does a highlight in a
change, or one inside `\mathbf{}`, `\text{}` or another style's group, which
writes its text as one run. One on syntax rather than math, as in
`$x{==^2==}$`, or on a structure with no text, as `\sum`, is left out, and the
equation stays whole. An inline equation still splits at a highlight with
CriticMarkup or a `%` comment in it, or one that opens a brace it doesn't
close, and at a comment. So does one in a highlight, as `==$a{==b==}c$==`, whose pieces each
take the highlight around them.

In display math, a highlight inside the equation is LaTeX, as before: Word
shows `$$a{==b==}c$$` as `a==b==c`. The preview leaves display math to VS
Code's KaTeX, which shows the markers too. Word's highlight on part of a
display equation doesn't come back.

Since CriticMarkup works inside an equation, a group whose content starts
with `++`, `--`, `==`, `~~` or `>>` reads as the start of a change, and one
that ends with `++`, `--`, `==`, `~~` or `<<` reads as the end of one, even in
another paragraph. Write `\relax` between the two characters, as in
`$\mathrm{Ca}^{+\relax+}$` or `$\sqrt{x+\relax+}$`. LaTeX sets them as
without it, and export writes the same characters to Word. `{}` there would
add space around them outside a superscript or subscript, and after an
operator such as `\sum^+` would be its body. Import does the same with such
characters from Word: a superscript of `++` comes back as `x^{+\relax+}`.

## Quick Examples

```markdown
The quadratic formula is $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.

The sum of the first $n$ natural numbers:

$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$
```

## Subscripts and Superscripts

```latex
x^2          % superscript
x_i          % subscript
x_i^2        % both
x_{i+1}      % multi-character subscript (use braces)
a^{n+1}      % multi-character superscript (use braces)
```

An empty script or base, as in `x^{}` or `{}^{14}C`, is an empty part in Word, which Word shows as a dotted box, and comes back as `{}`. So is an empty numerator or denominator, as in `\frac{}{}`.

Word's scripts before a base, as on an isotope, come back as scripts on an empty base before it, as in `{}_6^{14}C`, which export writes that way.

## Fractions and Roots

```latex
\frac{a}{b}        % fraction: a/b
\dfrac{a}{b}       % display-style fraction (all become \frac on re-import)
\tfrac{a}{b}       % text-style fraction (all become \frac on re-import)
\cfrac{a}{b}       % continued fraction (all become \frac on re-import)
{a}/{b}            % linear fraction: a/b on one line
\genfrac{}{}{0pt}{}{a}{b}  % fraction without a bar
\sqrt{x}           % square root
\sqrt[3]{x}        % cube root
\sqrt[n]{x}        % nth root
```

`{a}/{b}` is Word's linear fraction where nothing stands between the braces and the `/`, and no script follows the `{b}`, which would take it alone. Word's skewed fraction comes back as a linear one.

`\genfrac{}{}{0pt}{}{a}{b}` is Word's fraction without a bar, and import writes Word's that way, except in parentheses alone, where it's `\binom{a}{b}`. A `\genfrac` with delimiters, another rule thickness or a style exports as an unknown command.

## Greek Letters

| Lowercase | | Uppercase | |
|-----------|---|-----------|---|
| `\alpha` α | `\nu` ν | `\Gamma` Γ | `\Xi` Ξ |
| `\beta` β | `\xi` ξ | `\Delta` Δ | `\Pi` Π |
| `\gamma` γ | `\pi` π, `\varpi` ϖ | `\Theta` Θ | `\Sigma` Σ |
| `\delta` δ | `\rho` ρ, `\varrho` ϱ | `\Lambda` Λ | `\Upsilon` Υ |
| `\epsilon` ϵ, `\varepsilon` ε | `\sigma` σ, `\varsigma` ς | | `\Phi` Φ |
| `\zeta` ζ | `\tau` τ | | `\Psi` Ψ |
| `\eta` η | `\upsilon` υ | | `\Omega` Ω |
| `\theta` θ, `\vartheta` ϑ | `\phi` ϕ, `\varphi` φ | | |
| `\iota` ι | `\chi` χ | | |
| `\kappa` κ | `\psi` ψ | | |
| `\lambda` λ | `\omega` ω | | |
| `\mu` μ | | | |

Each variant has its own character, so `\epsilon` (ϵ) and `\varepsilon` (ε) stay distinct in Word and on re-import. The plain Greek ε and φ that most fonts and keyboards produce import as `\varepsilon` and `\varphi`, since that is how they look.

## Operators and Symbols

| Symbol | LaTeX | | Symbol | LaTeX |
|--------|-------|-|--------|-------|
| × | `\times` | | ∈ | `\in` |
| ÷ | `\div` | | ∉ | `\notin` |
| ± | `\pm` | | ⊂ | `\subset` |
| ∓ | `\mp` | | ⊃ | `\supset` |
| ≤ | `\leq` | | ∪ | `\cup` |
| ≥ | `\geq` | | ∩ | `\cap` |
| ≠ | `\neq` | | → | `\to` |
| ≈ | `\approx` | | ← | `\leftarrow` |
| ∞ | `\infty` | | ⇒ | `\Rightarrow` |
| ∂ | `\partial` | | ⇐ | `\Leftarrow` |
| ∇ | `\nabla` | | ↔ | `\leftrightarrow` |
| ∀ | `\forall` | | ∧ | `\land` |
| ∃ | `\exists` | | ∨ | `\lor` |
| ¬ | `\neg` | | ⊕ | `\oplus` |
| · | `\cdot` | | ⊗ | `\otimes` |
| ∼ | `\sim` | | ⊆ | `\subseteq` |
| ≃ | `\simeq` | | ⊇ | `\supseteq` |
| ≡ | `\equiv` | | ∖ | `\setminus` |
| ≅ | `\cong` | | ⊥ | `\perp` |
| ∝ | `\propto` | | ∘ | `\circ` |
| ≪ | `\ll` | | ∗ | `\ast` |
| ≫ | `\gg` | | ∅ | `\emptyset` |
| ℓ | `\ell` | | ⇔ | `\Leftrightarrow` |
| ′ | `\prime` | | ↦ | `\mapsto` |
| ⟨ | `\langle` | | ⟩ | `\rangle` |
| ⊤ | `\top` | | ∋ | `\ni` |
| ⟹ | `\Longrightarrow` | | ⟸ | `\Longleftarrow` |
| ⟺ | `\Longleftrightarrow` | | ⟶ | `\longrightarrow` |
| ⩽ | `\leqslant` | | ⩾ | `\geqslant` |
| ⋆ | `\star` | | ∄ | `\nexists` |
| † | `\dagger` | | ‡ | `\ddagger` |
| ℏ | `\hbar` | | ∠ | `\angle` |
| ↑ | `\uparrow` | | ↓ | `\downarrow` |
| ℵ | `\aleph` | | | |
| ⌊ ⌋ | `\lfloor` `\rfloor` | | ⌈ ⌉ | `\lceil` `\rceil` |

The aliases `\le`, `\ge`, `\ne`, `\rightarrow`, `\gets`, `\lnot`, `\wedge`, and `\vee` also work. Re-import writes them as `\leq`, `\geq`, `\neq`, `\to`, `\leftarrow`, `\neg`, `\land`, and `\lor`. The double bar ‖ is `\|`. Likewise `\vert`, `\lvert`, and `\rvert` come back as `|`, `\Vert`, `\lVert`, and `\rVert` as `\|`, `\bot` as `\perp`, `\varnothing` as `\emptyset`, and `\implies` and `\iff` as `\Longrightarrow` and `\Longleftrightarrow`.

A `'` in math exports as the prime ′. On re-import, a ′ in a subscript, superscript, or limit comes back as `\prime`, and one at the base level of the equation as `'`. An apostrophe inside `\text{}` stays an apostrophe.

A command the converter doesn't know exports as literal text, such as `\foo` in the equation. The export warns once for each such command. Escaped characters such as `\%` outside `\text{}` also export as written, backslash included, but without a warning. Inside `\text{}`, `\mathrm{}`, and the math alphabets below, they export as the plain character. `\$`, `\{`, `\}`, `\_`, `\#` and `\&` are the exceptions: they export as the character anywhere in an equation, but for all of them but `\$` in an equation whose text in Word holds LaTeX, and for `\#` and `\&` in a row of an equation array, as below. Import writes a dollar sign in a Word equation as `\$`, since a bare `$` would end the equation, so Word's `$x` comes back as `$\$x$`. A `\$` that an older version exported to Word as text, backslash included, comes back as `\$` and exports as a dollar sign.

Import writes a brace in a Word equation as `\{` or `\}` too, since export reads a bare one as a group's brace, which Word doesn't show: Word's `{x}` comes back as `$\{x\}$`, not as `$x$`. A brace in a style's group, as `\mathbf{\{x\}}`, or in `\text{}`, already came back so. An equation whose text in Word holds a backslash or a `%`, as the `\begin{array}{cc}` or `\foo` that export writes as text for what Word has no form for does, keeps its braces as written, as before: which of them are LaTeX's, as a command's argument, is LaTeX's reading of the text, which Word may split into runs anywhere. Export writes `\{` and `\}` in such an equation as written, backslash included, as before, so `$\foo\{x\}$` comes back as it was. A `\{` or `\}` that an older version exported to Word as text, backslash included, comes back as written, and exports as the brace where nothing else in the equation holds LaTeX.

A brace the equation doesn't close, as in `$x { y$`, or one that closes nothing, as in `$x } y$`, exports as the character, which comes back as `\{` or `\}`, or as written in an equation whose text in Word holds LaTeX, as `$\foo { x$`, where it's unmatched again. Export dropped it, so Word showed `x y`. The group of a command or a script that the equation doesn't close, as in `\frac{a}{b` or `x^{2`, still closes at the equation's end, as LaTeX's error recovery closes it.

Import writes an underscore, a `#` or an `&` in a Word equation as `\_`, `\#` or `\&` too, in the equations whose braces it escapes, those whose text in Word holds no backslash and no `%`. Export read a bare `_` as a subscript, so Word's `a_b` came back as `$a_b$`, and the next export made `b` a subscript of `a`. An `&` in a matrix's cell split the cell in two, and a bare `#` or `&` elsewhere isn't valid LaTeX. In a row of an equation array, as in `aligned`, `gathered` or `cases`, or in display math with a `\tag`, which Word holds as such a row, a `#` or an `&` stays as it is, as before: Word reads a `#` there as the row's equation number (see Equation numbers) and an `&` as its alignment point, as LaTeX reads an `&`. Export writes `\#` and `\&` there as written, backslash included, as before. A `\_`, `\#` or `\&` that an older version exported to Word as text, backslash included, comes back as written, and exports as the character where nothing else in the equation holds LaTeX.

Import writes a backslash in a Word equation as `\backslash` where it can't start LaTeX typed in Word: at the end of the equation or of a part of it, such as a subscript, a matrix's cell, a row or a tracked change, and before a structure such as a fraction, a tracked change, a highlight, a comment, or a character that import writes as a command, such as α or ′. Before, the backslash ran into what import wrote next. Word's `x\` at the end of an inline equation came back as `$x\$`, which is no equation. Word's `x\` and `α#(1)` came back as `x\\alpha \tag{1}`, a line break and no number, and a subscript `a\` lost its closing brace. Brackets after the backslash, or at the end of whose content it is, come back with `\left` and `\right`, as `x\backslash\left(y\right)` and `\left(x\backslash\right)`, since export writes bare brackets as text, which the backslash would join. Brackets that LaTeX can't size, such as « », and brackets with a separator that `\middle` can't take, such as a comma, stay bare, and a backslash before or in them stays as it is, as before.

Export writes `\backslash` as Word's `\` only where import is sure to read it back as `\backslash`: at the end of the equation or of a part of it other than brackets that import writes bare, and before a structure, brackets that import writes with `\left` and `\right`, a tracked change with text, a comment, a symbol such as α, or, in an inline equation, the edge of a highlight outside any structure. Elsewhere it exports as text, backslash included, as before. That's before Word text that LaTeX would read on from the backslash, such as a letter, a digit, a `#` or an `&`, and before what import might drop, or join to the backslash: an empty `\text{}`, a tracked change of spaces alone, a styled run such as `\mathit{b}`, brackets that import writes bare, such as `\left<b\right>`, which comes back as `<b>`, or a highlight where import reads none, as in a script. So `$a\backslash b$` doesn't come back as `$a\b$`, and a `\tag` or an alignment point after it keeps its number or its alignment. A tracked change next to it stays tracked in place. Before a space, it exports as text too, as before, whether the space is one TeX skips, as in `$x\backslash \alpha$`, or a control space, as in `$x\backslash\ \alpha$`. Export writes both as a space, and import reads that back as a space TeX skips, so `$x\backslash\ \alpha$` comes back as `$x\backslash \alpha$`, as before. A space at the end of a part, as import writes before a matrix's `&`, doesn't count.

A backslash before Word text that LaTeX reads on from it stays as it is, as before. It may be LaTeX typed in Word, or a `\{`, `\$`, `\_`, `\#` or `\&` that an older version exported as text. So Word's `x\` and `b` come back as `$x\b$`, `x\` and `{y` as `$x\{y$`, `x\^2` as `$x\^2$`, and `x\ y` as `$x\ y$`, which LaTeX reads as a space. A backslash in a comment is the comment's text, as before.

A `^`, `~` or `%` in a Word equation still comes back as it is. Word's `a^b` comes back as `$a^b$`, which the next export makes a superscript, and `a%b` as `$a%b$`, whose `%b` exports as a comment. Word's `a~b` comes back as `$a~b$`, which exports as Word's `a~b` again, but LaTeX shows `~` as a space.

## Dots

| Symbol | LaTeX | Description |
|--------|-------|-------------|
| … | `\ldots` | Low dots |
| ⋯ | `\cdots` | Centered dots |
| ⋱ | `\ddots` | Diagonal dots |
| ⋮ | `\vdots` | Vertical dots |
| … | `\dots` | Generic dots (also `\dotsc`, `\dotsb`, `\dotsm`, `\dotsi`) |

## Sums, Integrals, and Products

| Symbol | LaTeX | Description |
|--------|-------|-------------|
| ∑ | `\sum` | Summation |
| ∏ | `\prod` | Product |
| ∫ | `\int` | Integral |
| ∬ | `\iint` | Double integral |
| ∭ | `\iiint` | Triple integral |
| ∮ | `\oint` | Contour integral |
| ⋃ | `\bigcup` | Big union |
| ⋂ | `\bigcap` | Big intersection |

These operators support subscript/superscript limits:

```latex
\sum_{i=1}^{n} x_i                 % sum with limits
\prod_{k=1}^{n} k                  % product
\int_{0}^{1} f(x) dx               % definite integral
\int f(x) dx                       % indefinite integral
\iint_{D} f(x,y) dA                % double integral
\oint_{C} F \cdot dr               % contour integral
```

To place limits above/below (instead of as subscript/superscript):

```latex
\sum\limits_{i=1}^{n} x_i
```

`\nolimits` does the reverse and keeps the limits beside the operator. Re-import drops it, so the limits fall back to the default placement.

A group in parentheses or brackets, or a `\left` and `\right` pair, right after the operator becomes its body in Word. In `\prod_{t=1}^{12}(1-\omega_t)`, all of `(1-\omega_t)` sits under the product. Otherwise the body is the one character, command or braced group after the operator, with its scripts: in `\sum_i x_i y`, only `x_i` is under the sum. To put more under it, brace the body: `\prod{(1-x)y}`. Re-import adds those braces when a body from Word is more than one piece, as an integral's `f(x)dx` comes back as `\int_0^1{f(x)dx}`, or starts with a bracket but isn't one whole group, as `(1-x)y`. An operator written without a limit gets a hidden empty slot, so Word draws no placeholder box where the limit would go.

## Functions

Known function names are rendered upright (roman) in the equation:

```
sin   cos   tan   cot   sec   csc
arcsin  arccos  arctan
sinh  cosh  tanh  coth
log   ln    exp   lim   max   min
sup   inf   det   dim   gcd   deg
arg   hom   ker   Pr    liminf  limsup
```

```latex
\sin{x}  \cos{\theta}  \tan{x}  \log{n}  \ln{x}  \exp{x}
\lim{x}  \max{S}  \min{S}  \det{A}  \gcd{a, b}
```

For functions not in this list, use `\operatorname{name}`:

```latex
\operatorname{tr}{A}
```

A function name followed by `(...)` or `[...]` takes the whole group as its argument, as in `\log(x+1)` or `\operatorname{margin}(j)`. Re-import writes an argument that is one such group, or one `\left` and `\right` pair, without braces, and braces any other: `\log{(x+1)y}`.

Scripts on a function name stay with the name, as Word places them. `\log_2 n` and `\sin^2 x` put the script beside the name. `\lim`, `\liminf`, `\limsup`, `\max`, `\min`, `\sup`, `\inf`, `\det`, `\gcd`, and `\Pr` put a subscript under the name, and so does `\operatorname*`:

```latex
\lim_{n \to \infty} a_n
\max_i x_i
\operatorname*{argmax}_x f(x)
```

`\limits` or `\nolimits` right after the name moves its scripts under or beside it, as in `\lim\nolimits_n a_n`. Re-import keeps the placement.

## Math Alphabets

| LaTeX | Word style |
|-------|------------|
| `\mathbf{x}` | bold upright |
| `\boldsymbol{\beta}` | bold italic |
| `\mathit{x}` | italic |
| `\mathbb{R}` | double-struck |
| `\mathfrak{g}` | Fraktur |
| `\mathsf{A}` | sans-serif |
| `\mathtt{v}` | monospace |
| `\mathcal{L}` | script |

Each takes plain letters or symbols. Scripts go outside: `\boldsymbol{\beta}_c`.

## Accents and Decorations

```latex
\hat{x}     % circumflex: x̂
\bar{x}     % overbar: x̄
\vec{x}     % vector arrow
\tilde{x}   % tilde: x̃
\dot{x}     % single dot: ẋ
\ddot{x}    % double dot: ẍ
\check{x}   % caron: x̌
\widehat{x}   % same as \hat in Word; re-imports as \hat
\widetilde{x} % same as \tilde in Word; re-imports as \tilde
\cancel{x}    % struck from bottom left to top right
\bcancel{x}   % struck from top left to bottom right
\xcancel{x}   % struck both ways
\sout{x}      % struck across
```

Each strike is Word's border box with its sides hidden and that strike, and comes back as written. Any other border box from Word, as one with only some sides hidden, comes back as `\boxed{}`.

## Delimiters

Auto-sizing with `\left` and `\right`:

```latex
\left( \frac{a}{b} \right)      % parentheses
\left[ x + y \right]            % brackets
\left\{ a, b, c \right\}        % braces, also \lbrace \rbrace
\left| x \right|                % absolute value
\left\| v \right\|              % norm (double bars), also \Vert
\left\langle u, v \right\rangle  % angle brackets
\left\lfloor x \right\rfloor    % floor (also \lceil \rceil)
```

On re-import, braces, angle brackets, floor and ceiling brackets, double bars, and arrows keep their `\left` and `\right`. Parentheses, square brackets, and single bars come back as plain characters, such as `(x)`.

One-sided delimiter (invisible on the other side):

```latex
\left. \frac{df}{dx} \right|_{x=0}
```

A separator that grows with the delimiter, with `\middle`:

```latex
\left\{ x \middle| x > 0 \right\}
```

In Word, `\middle` splits the delimiter's content into parts, with the separator between them. A Word delimiter's separator comes back as `\middle`, with `\left` and `\right`, even around parentheses, square brackets or single bars, as `\left(a\middle|b\right)`. Word's delimiter has one separator character, so `\middle` with different ones, as `\middle|` and `\middle/` in one delimiter, exports as those characters, which don't grow. A `\middle` outside `\left` and `\right` exports as its character, as a `\right` without a `\left` does. A Word separator `\middle` can't take, as a comma, a `.` typed as itself (`\middle.` is no separator), or `∣`, which LaTeX has as the relation `\mid`, comes back as that character between the parts, as `(a,b)`. So does one in a delimiter with neither bracket, or with a bracket `\left` or `\right` can't take, as `,a|b,`.

## Matrices

| Environment | Delimiters | Description |
|-------------|------------|-------------|
| `matrix` | None | Plain matrix |
| `pmatrix` | ( ) | Parenthesized |
| `bmatrix` | [ ] | Bracketed |
| `Bmatrix` | { } | Braced |
| `vmatrix` | \| \| | Determinant |
| `Vmatrix` | ‖ ‖ | Double-bar |
| `smallmatrix` | None | Inline-sized |

```latex
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
```

Use `&` to separate columns and `\\` to separate rows.

## Multi-line Equations (amsmath)

The converter supports standard amsmath environments for multi-line equations:

| Environment | Description |
|-------------|-------------|
| `equation`, `equation*` | Single equation (starred = unnumbered) |
| `align`, `align*` | Aligned equations with `&` alignment points |
| `aligned` | Aligned block within an equation |
| `gather`, `gather*` | Centered equations (no alignment) |
| `gathered` | Gathered block within an equation |
| `multline`, `multline*` | Long equation split across lines |
| `split` | Split equation within an equation |
| `cases` | Piecewise definitions with `{` delimiter |
| `flalign`, `flalign*` | Full-width aligned equations |
| `alignat`, `alignat*` | Aligned with explicit column count |
| `subequations` | Wrapper (content passed through) |

These environments are converted to OMML equation arrays on export. On re-import, the original environment name is not preserved: arrays with `&` markers become `aligned`, those without become `gathered`, or `align*` and `gather*` when a row has a number (see [Equation numbers](#equation-numbers)). Every row comes back, an empty one too, so the next export has the same rows. A row that ends in a `%` comment has its `\\` on the next line, out of the comment.

Within these environments, `\label{...}`, `\notag`, and `\nonumber` are consumed silently (OMML has no equivalent). `\tag{...}` becomes Word's equation number (see [Equation numbers](#equation-numbers)). `\intertext{...}` and `\shortintertext{...}` are emitted as plain text. `\shoveleft{...}` and `\shoveright{...}` emit their inner content.

An environment not in this table or under Matrices, such as `array`, `eqnarray`, `dcases`, `rcases`, `subarray`, `alignedat` or `CD`, has no OMML form. Export shows its `\begin{...}` with any argument (an `array`'s column spec) and its `\end{...}` as text, with the body between them as math, and warns once. Import reads it back as written. One with no `\end{...}` of its own shows only its `\begin{...}` as text, and the rest as math.

### Equation numbers

Word numbers an equation with a `#` at the end of a row of an equation array, followed by the number, as in `E=mc^2#(1)`, and shows the number at the right margin. In display math, export writes `\tag{1}` that way:

- A `\tag` in `align`, `align*`, `gather`, `gather*`, `multline`, `flalign` or `alignat` numbers its own row.
- Anywhere else, as in an equation without an environment, `equation`, `aligned` or `cases`, it numbers the whole equation. Export makes the equation one row of an equation array, as Word does.
- `\tag*{A}`, which LaTeX shows without parentheses, is written as `#A`.

Import reads Word's numbers in display math back as `\tag{...}`, or as `\tag*{...}` where the number has no parentheses:

- A numbered equation of one row comes back as the row and its tag, as in `E=mc^2 \tag{1}`.
- All of a row after its `#` is the number, as Word shows it, so `x#a(1)` comes back as `x \tag*{a(1)}`.
- An equation array with more rows comes back as `align*` (with `&`) or `gather*`, with each number on its row. An `&` in a number aligns nothing.
- LaTeX's special characters in a number are escaped, as in `\text{}`: Word's `#(50%)` comes back as `\tag{50\%}`, `#(a_b)` as `\tag{a\_b}`, and `#(a\b)` as `\tag{a\textbackslash{}b}`. Export writes such a tag's text as LaTeX shows it, so `\tag{50\%}` comes back as written. A text accent or a tie, as in `\tag*{x\^2}` or `\tag{a~b}`, is written as typed, and comes back as the characters Word shows, as in `\text{}`.

In inline math, which can't hold a `\tag`, a number stays as Word wrote it.

Some tags are dropped, as before:

- a `\tag` in inline math;
- a `\tag` inside CriticMarkup, or with CriticMarkup inside it;
- a `\tag*` with a `#` in it, whose number would be a row with two `#`s (see below).

A tracked change in a row before its `\tag` stays out of the number. Word gets the number in the row, after the change, and import writes the `\tag` back after it, as in `x {--E--} \tag{1}` or `{~~E~>F~~} \tag{1}`. That holds where the change is all of the row before the `\tag` too, as in `{--E--} \tag{1}` or `{++E++} \tag{1}`, on a row of `align*` or `gather*` as well. Accepting such a deletion in Word, or rejecting such an insertion, leaves a row of the number alone, as LaTeX shows the `\tag` of an empty row. Import reads a `#` with nothing before it as no number, so that row comes back as `#(1)` in `gathered`.

A row from Word with more than one `#` in its math, as `x#(A#B)`, stays as Word wrote it, since it's unclear which `#` starts the number. A `#` inside the parentheses Word builds up is no other `#`, so `\tag{A\#B}`, which export writes that way, comes back.

### Bare Environments

You can write display-math environments without `$$` wrappers:

```latex
\begin{align}
  a &= b \\
  c &= d
\end{align}
```

This is treated as an alias for:

```latex
$$
\begin{align}
  a &= b \\
  c &= d
\end{align}
$$
```

All environments listed in the table above are recognized as bare environments, plus the matrix variants (`matrix`, `smallmatrix`, `pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix`, `Vmatrix`). Bare environments are not recognized inside code blocks, HTML comments, CriticMarkup spans, or existing `$$` blocks.

A bare environment in a quote, an alert or a list item is recognized at the start of a line of the quote's or the item's text, as `> \begin{equation}`, and its `$$` go on the lines of its `\begin` and its `\end`, inside the quote or the item. It stays as written where its paragraph has a line without the quote's `>` or the item's indent, where it runs past the paragraph, where text follows its `\end` on that line, where the next line is a lone HTML tag, a link definition, a list item or indented four spaces more, in a quote in a list item in a quote, where it or another environment in its paragraph holds nothing or stays as written, or where a link, an image, a citation, a tag, a URL, a highlight or CriticMarkup comes before it in its paragraph.

On round-trip through DOCX, bare environments are converted to the `$$`-wrapped form.

### Aligned equations (with `&` alignment points)

```latex
\begin{align*}
  f(x) &= x^2 + 2x + 1 \\
       &= (x + 1)^2
\end{align*}
```

### Centered equations (no alignment)

```latex
\begin{gather*}
  x + y = z \\
  a + b = c
\end{gather*}
```

### Piecewise definitions

```latex
f(x) = \begin{cases}
  x^2 & \text{if } x \geq 0 \\
  -x  & \text{if } x < 0
\end{cases}
```

### Long equations split across lines

```latex
\begin{multline*}
  p(x) = x^8 + x^7 + x^6 + x^5 \\
  + x^4 + x^3 + x^2 + x + 1
\end{multline*}
```

## Comments

In LaTeX, `%` starts a line comment — everything from `%` to the end of the line is ignored by the LaTeX engine. Comments are useful for annotating equations without affecting the rendered output:

```latex
x^2          % superscript
x_i          % subscript
x + y%       % line continuation (suppresses newline whitespace)
+ z
```

Escaped `\%` is not treated as a comment. LaTeX shows it as a percent sign. Word shows it as written, backslash included, as with the other escaped characters outside `\text{}`:

```latex
50\% discount   % LaTeX shows 50% discount, Word 50\% discount
```

### Line continuation

A `%` at the end of a line acts as a **line continuation**: it suppresses the newline and any leading whitespace on the following line, joining the two source lines as if no break existed. This lets you split a long equation across multiple source lines for readability without introducing unwanted spaces in the rendered output:

```latex
% Without continuation — the newline produces a space between y and +z:
x + y
+ z          % renders: x + y + z  (note the extra space)

% With continuation — joined without extra space:
x + y%
+ z          % renders: x + y+ z
```

This is standard LaTeX behavior: because `%` starts a comment, everything from the `%` through the end of the line (including the newline itself) is consumed, and the next line's content follows immediately.

**Line continuation vs. `\\` (line break):** These serve opposite purposes. `%` at end-of-line joins two source lines into one logical line (removing a break), while `\\` creates a visible line break within multi-line environments like `align*`, `gather*`, and `cases` (adding a break). In other words, `%` is for splitting long input across source lines without affecting the equation; `\\` is for splitting the equation itself across display lines.

### Roundtrip behavior

When a LaTeX equation containing `%` comments is exported to Word `.docx`, the comments are stripped from the visible equation but preserved as hidden elements within the OMML structure. They are invisible in Word. On re-import from `.docx` back to Markdown, the comments are restored at their original positions — including any whitespace before the `%`, so vertically aligned comments stay aligned after roundtrip. A comment inside `\mathbf{}`, `\mathrm{}`, or another alphabet command splits it in two: `\mathbf{x% note` with `y}` on the next line comes back as `\mathbf{x}% note` with `\mathbf{y}` on the next line. A comment inside `\text{}` splits it the same way: `\text{a b% note` with `c d}` on the next line comes back as `\text{a b}% note` with `\text{c d}` on the next line. A part of one word comes back as `\mathrm{}`, as `\text{ab}` does. A comment in an `\operatorname{}` name is still lost. A comment at the end of any other group, as `x^{a% note` with `}y` on the next line, or of a delimiter's or a root's degree's content, comes back with its line end, so the brace, bracket or delimiter that closes it stays out of the comment.

## Binomial Coefficients

```latex
\binom{n}{k}       % binomial coefficient
\dbinom{n}{k}      % display-style binomial (all become \binom on re-import)
\tbinom{n}{k}      % text-style binomial (all become \binom on re-import)
```

## Boxed Equations

```latex
\boxed{E = mc^2}
```

A box Word puts around an operator, as `≝`, or a differential, as `dx`, without a border, comes back as its content.

## Phantoms

```latex
\phantom{x}    % the space x takes, with nothing shown
\hphantom{x}   % its width alone
\vphantom{x}   % its height alone
```

Each is a phantom Word hides, and comes back as written. A phantom Word shows comes back as its content.

## Over/Under Annotations

```latex
\overline{AB}              % overline
\underline{x+y}            % underline
\overbrace{a+b+c}          % overbrace
\underbrace{x+y+z}         % underbrace
\overset{\text{def}}{=}    % symbol with annotation above
\underset{x \to 0}{\lim}   % symbol with annotation below
```

Export writes `\overbrace` and `\underbrace` as Word's group character, a curly bracket over or under its content. Import reads a group character by its character: `⏞` comes back as `\overbrace`, `⏟` as `\underbrace`, and any other character, such as an arrow, as `\overset` or `\underset` of that character, by its position, as `\overset{\to}{x}`. A character math can't hold as it is, as `&`, `\` or `'`, which math reads as a prime, goes in as text, as `\overset{\text{\&}}{x}`, so Word gets the character back as it was. Where Word leaves out the character or the position, import uses ECMA-376's defaults, `⏟` at the bottom.

A superscript right after `\overbrace{...}`, or a subscript right after `\underbrace{...}`, is the brace's label, which Word shows over or under the brace, as `\overbrace{a+b}^{n}`. A script Word has on a brace, which isn't a label, comes back with the brace in braces, as `{\overbrace{y}}^b`, so it stays a script.

## Spacing

LaTeX adds its own spacing around operators, but you can adjust manually:

```latex
a \, b     % thin space
a \: b     % medium space
a \; b     % thick space
a \! b     % negative thin space (removed in OMML)
a \ b      % normal space
a \quad b  % em space
a \qquad b % double em space
```

At the start or end of an equation, a row, a cell or a group, re-import writes the spaces that `\quad`, `\qquad`, `\;`, `\:` and `\,` export as those commands. So it does after a number that starts an inline equation, as in `$2\quad x$`, since `$2` followed by a space reads as a dollar amount, not math. There it writes a space or tab as `\ `, as in `$2\ x$`, whether Word has it in a run of its own, as export writes `\ `, or in the number's run, as Word writes `2 x` typed in an equation. A space of another kind there, as a no-break space, is written as itself after an empty group, as `2{}` and then the space, since `\ ` would export as an ordinary space. Elsewhere it writes the space itself, as U+2003 for `\quad` or a space for `\ `. An equation, a row, a cell or a group of those spaces alone comes back as the commands too, as `$\quad$` or `\frac{\quad}{2}`. Between brackets that export writes as text, as `( )` with an em space, it writes the space itself. A space or `\ ` alone is still no equation.

## Text Inside Equations

```latex
x = 0 \text{ if } y > 1
\mathrm{constant}
```

Spaces at the edges of `\text{}` show in Word. Word's Normal Text imports as upright text from Word does: as `\text{}`, with the spaces at its edges, where it holds a space or a character LaTeX reserves, such as `%`, and as `\mathrm{}` otherwise. Normal text from Word that contains a symbol imports with the symbol outside the text, as in `\text{a }\mathrm{\times}\text{ b}`, since `\text{}` cannot hold math commands.

## Mod

```latex
a \bmod b            % binary mod: a mod b
a \equiv b \pmod{n}  % parenthetical mod: (mod n)
```

## Style Commands

`\displaystyle` and `\textstyle` are accepted but silently consumed — OMML does not have direct equivalents.

## Complete Example

A full Manuscript Markdown document with equations:

```markdown
---
title: Fourier Series
---

# Introduction

Any periodic function $f(x)$ with period $2\pi$ can be expressed
as an infinite sum of sines and cosines. The **Fourier series**
representation is:

$$f(x) = \frac{a_0}{2} + \sum_{n=1}^{\infty}
\left( a_n \cos{nx} + b_n \sin{nx} \right)$$

where the coefficients are given by:

$$a_n = \frac{1}{\pi} \int_{-\pi}^{\pi} f(x) \cos{nx} \, dx$$

$$b_n = \frac{1}{\pi} \int_{-\pi}^{\pi} f(x) \sin{nx} \, dx$$
```
