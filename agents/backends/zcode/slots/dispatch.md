The specialists are ZCode user-level subagents: dispatch via the Agent tool by name; the user can also @-mention a subagent in the chat input.

ZCode also ships built-in and plugin agents beside this roster — divide the labor, don't duplicate it:
- Code recon: roster explorer is the default lane; the built-in Explore agent substitutes when explorer is unavailable, and ZCode's plan mode dispatching it on its own is expected — accept its findings instead of re-searching the same ground. `general-purpose` is for work outside roster lanes only.
- Visual acceptance of rendered documents (pptx/docx/xlsx/pdf/poster/chart): the matching `*:visual-judge` plugin agent owns that pass; observer stays with screenshots, diagrams, and ad-hoc image analysis.
- A single small existing image may be Read directly (Screens and UI discipline).
