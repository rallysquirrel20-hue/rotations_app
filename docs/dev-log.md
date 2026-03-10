# Dev Log

Chronological record of development work on the rotations_app dashboard.

---

## 2026-03-10 -- Contribution Tab Enhancements

### Backend
- Expanded `/api/baskets/{name}/contributions` endpoint with per-ticker entry/exit dates (`first_dates`, `last_dates`), `current_weights`, and equity curve data (`equity_dates`, `equity_values` via cumulative product of daily contribution sums)

### Frontend -- ContributionChart
- Removed 8-quarter limit: all quarters now shown, newest-first
- Added Q/Y preset toggle with annual presets
- Enhanced hover panel with entry/exit dates and current weight
- Split canvas into top 25% equity % return area chart (blue/pink fill by sign) + bottom 75% contribution bar chart
- Restructured sidebar with `contrib-sidebar` flex layout

### Frontend -- ReturnsChart
- Added Q/Y toggle with annual presets
- Restructured sidebar layout (user-side changes)

### CSS
- Added `.contrib-sidebar`, `.contrib-preset-toggle`, `.contrib-toggle-btn` styles
- Updated `.contrib-quarter-presets` for scrollable overflow
