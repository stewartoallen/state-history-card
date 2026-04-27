# Changelog

## 0.1.1

- Improves mobile touch behavior for history popups. Swiping across a graph no longer opens a sticky popup, and active popups dismiss when the page scrolls.
- Adds automatic left label column sizing based on the widest displayed entity label.
- Adds configurable `label_width` support for overriding the left label column width.
- Keeps graph rows and timestamp labels aligned by sharing the same computed label column width.
- Merges adjacent numeric segments when their rounded `decimals` value matches, making numeric value labels more likely to fit.

## 0.1.0

- Initial public release candidate.
- Adds a Lovelace state history card for discrete state timelines.
- Supports explicit colors and labels per raw or translated state value.
- Supports inline state labels, hover details, visual editor controls, legends, and adaptive timeline labels.
