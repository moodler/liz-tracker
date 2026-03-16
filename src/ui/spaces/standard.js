// ── Space: Standard ──
// Self-registers with the space plugin registry
//
// Provides: (none — standard items use the default detail panel)
// Capabilities: none

registerSpacePlugin({
  name: "standard",
  label: "Standard",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 10h6M9 14h4"/></svg>',
  description: "Default tracker item view",
  capabilities: {},
  render: null,
  refreshDiscussion: null,
  refreshDashboard: null,
  cleanup: null,
});
