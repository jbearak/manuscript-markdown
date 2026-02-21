# LaTeX Equations

This is a quick reference for writing LaTeX equations in Manuscript Markdown. Equations are converted to Word's native equation format on export and back to LaTeX on import — see [DOCX Converter](converter.md#latex-equations) for converter details.

## Inline and Display Math

Wrap equations in dollar signs:

- **Inline**: `$E = mc^2$` — renders within the text flow
- **Display**: `$$E = mc^2$$` — renders as a centered block equation

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
| `\gamma` γ | `\pi` π | `\Theta` Θ | `\Sigma` Σ |
| `\delta` δ | `\rho` ρ | `\Lambda` Λ | `\Phi` Φ |
| `\epsilon` ε | `\sigma` σ | | `\Psi` Ψ |
| `\zeta` ζ | `\tau` τ | | `\Omega` Ω |
| `\eta` η | `\upsilon` υ | | |
| `\theta` θ | `\phi` φ | | |
| `\iota` ι | `\chi` χ | | |
| `\kappa` κ | `\psi` ψ | | |
| `\lambda` λ | `\omega` ω | | |
| `\mu` μ | | | |

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

## Functions

Known function names are rendered upright (roman) in the equation:

```
sin   cos   tan   cot   sec   csc
arcsin  arccos  arctan
sinh  cosh  tanh  coth
log   ln    exp   lim   max   min
sup   inf   det   dim   gcd   deg
arg   hom   ker
```

```latex
\sin{x}  \cos{\theta}  \tan{x}  \log{n}  \ln{x}  \exp{x}
\lim{x}  \max{S}  \min{S}  \det{A}  \gcd{a, b}
```

For functions not in this list, use `\operatorname{name}`:

```latex
\operatorname{tr}{A}
```

## Accents and Decorations

```latex
\hat{x}     % circumflex: x̂
\bar{x}     % overbar: x̄
\vec{x}     % vector arrow
\tilde{x}   % tilde: x̃
\dot{x}     % single dot: ẋ
\ddot{x}    % double dot: ẍ
\check{x}   % caron: x̌
```

## Delimiters

Auto-sizing with `\left` and `\right`:

```latex
\left( \frac{a}{b} \right)      % parentheses
\left[ x + y \right]            % brackets
\left\{ a, b, c \right\}        % braces
\left| x \right|                % absolute value
\left\| v \right\|              % norm (double bars)
```

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

### Roundtrip behavior

When a LaTeX equation containing `%` comments is exported to Word `.docx`, the comments are stripped from the visible equation but preserved as hidden elements within the OMML structure. They are invisible in Word. On re-import from `.docx` back to Markdown, the comments are restored at their original positions — including any whitespace before the `%`, so vertically aligned comments stay aligned after roundtrip.

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
