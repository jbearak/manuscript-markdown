## How to read the counterfactuals

The unintended pregnancy rate is the number of unintended pregnancies per
1,000 women aged 15–49. Its denominator counts all women of reproductive age,
so it measures how common unintended pregnancy is in the population as a
whole:

$$
\text{UPR} = \frac{\text{unintended pregnancies}}{\text{women aged 15–49}}
\times 1000
$$

The same rate can be written as the product of two components:

$$
\text{UPR} =
\underbrace{\frac{\text{women who want to avoid pregnancy}}
{\text{women aged 15–49}}}_{\text{share at risk}}
\times
\underbrace{\frac{\text{unintended pregnancies}}
{\text{women who want to avoid pregnancy}} \times 1000}_{\text{conditional UPR}}
$$

This is the same quantity because the "women who want to avoid pregnancy"
term appears in the first component's numerator and the second component's
denominator, so it cancels, leaving the original ratio.

The first component is the share of women aged 15–49 who want to avoid
becoming pregnant — the share of the population "at risk" of unintended
pregnancy. The second is the conditional unintended pregnancy rate:
unintended pregnancies per 1,000 women *who want to avoid becoming pregnant*.
Because its denominator is restricted to the at-risk group, it measures how
likely a woman who wants to avoid pregnancy is to nonetheless experience an
unintended pregnancy.

The abortion rate (abortions per 1,000 women aged 15–49) multiplies in a third
component, the share of unintended pregnancies ending in abortion:

$$
\text{AR} = \text{share at risk} \times \text{conditional UPR} \times
\frac{\text{abortions}}{\text{unintended pregnancies}}
$$

The observed change lets every component move from its 1990–1994 value to its
2020–2024 value. Each counterfactual instead lets **only one** component move,
holding every other component at its 1990–1994 value, and reports the percent
change in the overall rate that would have resulted.
