# LaTeX Equations

This is a quick reference for writing LaTeX equations in Manuscript Markdown. Equations are converted to Word's native equation format on export and back to LaTeX on import — see [DOCX Converter](converter.md#latex-equations) for converter details.

## Inline and Display Math

Wrap equations in dollar signs:

- **Inline**: `$E = mc^2$` — renders within the text flow
- **Display**: `$$E = mc^2$$` — renders as a centered block equation
- **Bare environments**: `\begin{align}...\end{align}` — treated as `$$\begin{align}...\end{align}$$`

### Tracked changes inside inline equations

CriticMarkup can wrap a changed fragment inside an inline equation. Keep each
changed side as a self-contained LaTeX fragment:

```markdown
$u_j^2{+++\tau_{g_j}^2++}$
$a{~~+b~>+c~~}$
```

The first example marks `+\tau_{g_j}^2` as an addition. The second marks `+b`
as deleted and `+c` as inserted. These fragments render as equation content in
the preview and become tracked math revisions when exported to Word.

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

## Fractions and Roots

```latex
\frac{a}{b}        % fraction: a/b
\dfrac{a}{b}       % display-style fraction (all become \frac on re-import)
\tfrac{a}{b}       % text-style fraction (all become \frac on re-import)
\cfrac{a}{b}       % continued fraction (all become \frac on re-import)
\sqrt{x}           % square root
\sqrt[3]{x}        % cube root
\sqrt[n]{x}        % nth root
```

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

A command the converter doesn't know exports as literal text, such as `\foo` in the equation. The export warns once for each such command. Escaped characters such as `\%` and `\#` outside `\text{}` also export as written, backslash included, but without a warning. Inside `\text{}`, `\mathrm{}`, and the math alphabets below, they export as the plain character.

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

A group in parentheses or brackets, or a `\left` and `\right` pair, right after the operator becomes its body in Word. In `\prod_{t=1}^{12}(1-\omega_t)`, all of `(1-\omega_t)` sits under the product. To put more under it, brace the body: `\prod{(1-x)y}`. Re-import adds those braces when a body from Word starts with a bracket but isn't one whole group. An operator written without a limit gets a hidden empty slot, so Word draws no placeholder box where the limit would go.

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
```

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

These environments are converted to OMML equation arrays on export. On re-import, the original environment name is not preserved: arrays with `&` markers become `aligned`, those without become `gathered`.

Within these environments, `\tag{...}`, `\tag*{...}`, `\label{...}`, `\notag`, and `\nonumber` are consumed silently (OMML has no equivalent). `\intertext{...}` and `\shortintertext{...}` are emitted as plain text. `\shoveleft{...}` and `\shoveright{...}` emit their inner content.

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

Escaped `\%` produces a literal percent sign and is not treated as a comment:

```latex
50\% discount   % renders: 50% discount
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

When a LaTeX equation containing `%` comments is exported to Word `.docx`, the comments are stripped from the visible equation but preserved as hidden elements within the OMML structure. They are invisible in Word. On re-import from `.docx` back to Markdown, the comments are restored at their original positions — including any whitespace before the `%`, so vertically aligned comments stay aligned after roundtrip. A comment inside `\mathbf{}`, `\mathrm{}`, or another alphabet command splits it in two: `\mathbf{x% note` with `y}` on the next line comes back as `\mathbf{x}% note` with `\mathbf{y}` on the next line.

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

## Over/Under Annotations

```latex
\overline{AB}              % overline
\underline{x+y}            % underline
\overbrace{a+b+c}          % overbrace
\underbrace{x+y+z}         % underbrace
\overset{\text{def}}{=}    % symbol with annotation above
\underset{x \to 0}{\lim}   % symbol with annotation below
```

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

## Text Inside Equations

```latex
x = 0 \text{ if } y > 1
\mathrm{constant}
```

Spaces at the edges of `\text{}` show in Word. Normal text from Word that contains a symbol imports with the symbol outside the text, as in `\text{a }\mathrm{\times}\text{ b}`, since `\text{}` cannot hold math commands.

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
