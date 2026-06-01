# Project Brief: Dunena Redesign

## 1. Project Overview
**Dunena** is a high-performance, in-memory cache engine built on **Zig & Bun**. It aims to provide O(1) performance, native LRU eviction, and real-time streaming capabilities with zero-cost FFI bridges.

The goal of this project is to redesign the Dunena documentation and marketing site to reflect its high-performance, technical nature while providing an exceptional developer experience (DX).

## 2. Target Audience
- **Backend Engineers**: Looking for ultra-fast caching solutions.
- **Systems Architects**: Evaluating performance-critical infrastructure.
- **Open Source Contributors**: Navigating the codebase and technical architecture.

## 3. Brand Identity & Design System
The visual language, defined in the **Dunena Design System**, centers on a "Technical Aesthetic":
- **Theme**: Supports both Light and Dark modes with a primary focus on high contrast and technical clarity.
- **Typography**: Inter (Sans-serif) for primary UI elements; Monospace accents for technical data, code blocks, and architecture diagrams.
- **Color Palette**: 
  - **Surface**: Deep charcoals and rich blacks (`#10131a`) for Dark mode.
  - **Primary Accent**: Indigo/Lavender (`#a5b4fc`) for CTAs and highlights.
- **Layout**: Clean, grid-based structure with generous whitespace and clear information hierarchy.

## 4. Key Features & Functionality
- **Zig-Powered Core**: Highlighting O(1) cache operations and Bun FFI integration.
- **Multi-Interface Support**: Documentation for REST CRUD, Batch operations, and Real-Time WebSockets.
- **Performance Tooling**: Promotion of Prometheus metrics and the built-in Admin Dashboard.
- **Developer Experience**:
  - Interactive "Quick Start" code blocks.
  - Comprehensive CLI tool documentation.
  - Clear Architecture visualization showing the data flow between Bun, FFI, and the Zig Core.

## 5. Information Architecture
### Home Page
- **Hero**: Clear value proposition with immediate CLI installation snippets.
- **Feature Grid**: Detailed cards for TTL, Bloom Filters, and Compression.
- **Architecture Section**: Visual diagram of the engine internals.
- **Footer**: Navigation links and versioning info.

### Documentation (Docs)
- **Side Navigation**: Hierarchical access to "Introduction," "Quick Start," "Architecture," and "Core API."
- **Content Area**: Markdown-driven documentation with breadcrumbs.
- **Table of Contents**: "On This Page" sub-navigation for quick jumping.

## 6. Responsive Strategy
- **Desktop**: Full-width layouts with persistent sidebars for documentation.
- **Mobile**: 
  - Single-column stack for feature cards.
  - Sliding Navigation Drawer with smooth CSS transitions for mobile access to the guide.
  - Center-aligned hero elements for better mobile composition.

## 7. Technical Requirements
- **Framework**: HTML5/CSS3 (Tailwind CSS for styling).
- **Interactivity**: Vanilla JavaScript for menu animations and state management.
- **Performance**: Static site generation capability with fast load times.
- **Accessibility**: High color contrast and semantic HTML structure.
