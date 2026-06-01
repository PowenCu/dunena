/* ── Dunena Documentation Behavior ──────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  initLayout();
  initTheme();
  initCodeBlocks();
  initHeadingAnchors();
  initScrollProgress();
  initScrollSpy();
});

// ── Shared Navigation & Templates ────────────────────────
const SECTIONS = [
  {
    heading: "Getting Started",
    links: [
      { label: "Installation", href: "/docs/getting-started" },
      { label: "Quick Start", href: "/docs/getting-started#quick-start" },
      { label: "First Requests", href: "/docs/getting-started#first-requests" },
      { label: "Namespaces", href: "/docs/getting-started#namespaces" },
      { label: "TTL Expiry", href: "/docs/getting-started#ttl" },
      { label: "Scanning Keys", href: "/docs/getting-started#scan" },
    ],
  },
  {
    heading: "REST API",
    links: [
      { label: "Overview", href: "/docs/api" },
      { label: "Health Check", href: "/docs/api#health" },
      { label: "Health Probes", href: "/docs/api#health-probes" },
      { label: "GET /cache/:key", href: "/docs/api#get-key" },
      { label: "POST /cache/:key", href: "/docs/api#set-key" },
      { label: "DELETE /cache/:key", href: "/docs/api#delete-key" },
      { label: "Batch Operations", href: "/docs/api#batch" },
      { label: "Atomic Ops", href: "/docs/api#atomic" },
      { label: "CAS", href: "/docs/api#cas" },
      { label: "TTL Operations", href: "/docs/api#ttl-ops" },
      { label: "Cache Info", href: "/docs/api#cache-info" },
      { label: "Key Scanning", href: "/docs/api#keys" },
      { label: "Stats & Info", href: "/docs/api#stats" },
      { label: "Prometheus Metrics", href: "/docs/api#metrics" },
      { label: "Flush", href: "/docs/api#flush" },
      { label: "Snapshot", href: "/docs/api#snapshot" },
      { label: "Import / Export", href: "/docs/api#import-export" },
      { label: "SQLite Database", href: "/docs/api#database" },
      { label: "Query Cache", href: "/docs/api#query-cache" },
      { label: "Database Proxy", href: "/docs/api#db-proxy" },
      { label: "Distributed Locks", href: "/docs/api#locks" },
      { label: "Replication", href: "/docs/api#replication" },
      { label: "Rate Limiting", href: "/docs/api#rate-limits" },
      { label: "API Keys (RBAC)", href: "/docs/api#rbac" },
    ],
  },
  {
    heading: "WebSocket",
    links: [
      { label: "Connecting", href: "/docs/websocket" },
      { label: "Message Types", href: "/docs/websocket#messages" },
      { label: "Event Streaming", href: "/docs/websocket#events" },
    ],
  },
  {
    heading: "CLI",
    links: [
      { label: "Overview", href: "/docs/cli" },
      { label: "Commands", href: "/docs/cli#commands" },
      { label: "Flags", href: "/docs/cli#flags" },
      { label: "Benchmarking", href: "/docs/cli#benchmark" },
    ],
  },
  {
    heading: "Configuration",
    links: [
      { label: "Environment Variables", href: "/docs/configuration" },
      { label: "Cache Options", href: "/docs/configuration#cache" },
      { label: "Server Options", href: "/docs/configuration#server" },
      { label: "Authentication", href: "/docs/configuration#auth" },
      { label: "Logging", href: "/docs/configuration#logging" },
      { label: "Persistence", href: "/docs/configuration#persistence" },
      { label: "OpenTelemetry", href: "/docs/configuration#otel" },
      { label: "Clustering", href: "/docs/configuration#clustering" },
      { label: "RBAC", href: "/docs/configuration#rbac" },
      { label: "Redis Adapter", href: "/docs/configuration#redis" },
      { label: "Production Example", href: "/docs/configuration#production" },
    ],
  },
  {
    heading: "Architecture",
    links: [
      { label: "Overview", href: "/docs/architecture" },
      { label: "Zig Core", href: "/docs/architecture#zig-core" },
      { label: "FFI Bridge", href: "/docs/architecture#ffi-bridge" },
      { label: "Building", href: "/docs/architecture#building" },
      { label: "Monorepo", href: "/docs/architecture#monorepo" },
      { label: "Data Flow", href: "/docs/architecture#data-flow" },
      { label: "Pitfalls", href: "/docs/architecture#pitfalls" },
      { label: "Production", href: "/docs/architecture#production-constraints" },
      { label: "Tradeoffs", href: "/docs/architecture#tradeoffs" },
    ],
  },
];

function initLayout() {
  const headerPlaceholder = document.querySelector(".site-header");
  const sidebarPlaceholder = document.querySelector(".sidebar");

  const pathname = window.location.pathname;

  // 1. Inject Header
  if (headerPlaceholder) {
    headerPlaceholder.innerHTML = `
      <a href="/docs/" class="logo">
        <img src="/docs/assets/logo.svg" alt="Dunena logo" />
        <span class="wordmark">Dunena</span>
      </a>
      <nav>
        <a href="/docs/" class="nav-home">Home</a>
        <a href="/docs/getting-started" class="nav-guide">Guide</a>
        <a href="/docs/api" class="nav-api">API</a>
        <a href="/docs/api-explorer" class="nav-explorer">Explorer</a>
        <a href="/docs/websocket" class="nav-ws">WebSocket</a>
        <a href="/docs/cli" class="nav-cli">CLI</a>
        <a href="/docs/configuration" class="nav-config">Config</a>
        <a href="/docs/architecture" class="nav-arch">Architecture</a>
        <a href="/dashboard" class="nav-dash">Dashboard</a>
        <button class="theme-toggle" aria-label="Toggle theme">☀️</button>
      </nav>
    `;

    // Highlight main nav (only base path matching for header)
    const navLinks = headerPlaceholder.querySelectorAll("nav a");
    navLinks.forEach(link => {
      const href = link.getAttribute("href");
      if (isBasePathActive(pathname, href)) {
        link.classList.add("active");
      }
    });
  }

  // 2. Inject Sidebar
  if (sidebarPlaceholder) {
    let sidebarHtml = "";
    const currentHash = window.location.hash;
    SECTIONS.forEach(section => {
      sidebarHtml += `<div><h4>${section.heading}</h4>`;
      section.links.forEach(link => {
        const isActive = isLinkActive(pathname, currentHash, link.href);
        sidebarHtml += `
          <a href="${link.href}" class="${isActive ? 'active' : ''}" data-sidebar-href="${link.href}">
            ${link.label}
          </a>
        `;
      });
      sidebarHtml += "</div>";
    });
    sidebarPlaceholder.innerHTML = sidebarHtml;
  }

  // 3. Inject Back to Top Button
  if (!document.getElementById("back-to-top")) {
    const btn = document.createElement("button");
    btn.id = "back-to-top";
    btn.innerHTML = "▲";
    btn.setAttribute("aria-label", "Back to top");
    document.body.appendChild(btn);

    window.addEventListener("scroll", () => {
      if (window.scrollY > 300) {
        btn.classList.add("visible");
      } else {
        btn.classList.remove("visible");
      }
    });

    btn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
}

/**
 * Base path matching for header nav — ignores hash fragments.
 * Used only for the top navigation bar.
 */
function isBasePathActive(currentPath, targetHref) {
  const cleanPath = currentPath.split("#")[0].split("?")[0].replace(/\.html$/, "").replace(/\/$/, "");
  const cleanHref = targetHref.split("#")[0].split("?")[0].replace(/\.html$/, "").replace(/\/$/, "");

  if (cleanHref === "/docs" || cleanHref === "") {
    return cleanPath === "/docs" || cleanPath === "" || cleanPath === "/docs/index";
  }

  return cleanPath === cleanHref;
}

/**
 * Hash-aware matching for sidebar links.
 * - If the link has a hash (e.g. /docs/api#health), it only matches when the current
 *   page is /docs/api AND the current hash is #health.
 * - If the link has no hash (e.g. /docs/api), it matches when the current page is /docs/api
 *   AND there is no hash fragment in the URL (i.e. the "Overview" link).
 */
function isLinkActive(currentPath, currentHash, targetHref) {
  const [targetBase, targetHash] = splitHref(targetHref);
  const cleanPath = currentPath.split("#")[0].split("?")[0].replace(/\.html$/, "").replace(/\/$/, "");
  const cleanTarget = targetBase.replace(/\.html$/, "").replace(/\/$/, "");

  // Special case: docs home
  if (cleanTarget === "/docs" || cleanTarget === "") {
    const isHomePage = cleanPath === "/docs" || cleanPath === "" || cleanPath === "/docs/index";
    if (!isHomePage) return false;
    if (targetHash) return currentHash === "#" + targetHash;
    return !currentHash || currentHash === "" || currentHash === "#";
  }

  // Base path must match
  if (cleanPath !== cleanTarget) return false;

  // If target has a hash, current hash must match
  if (targetHash) {
    return currentHash === "#" + targetHash;
  }

  // Target has no hash: only active if no hash in URL (the "overview" link)
  return !currentHash || currentHash === "" || currentHash === "#";
}

function splitHref(href) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return [href, ""];
  return [href.slice(0, hashIndex), href.slice(hashIndex + 1)];
}

// Legacy function kept for backward compatibility (used nowhere now)
function isPathActive(currentPath, targetHref) {
  return isBasePathActive(currentPath, targetHref);
}

// ── Theme Management ─────────────────────────────────────
function initTheme() {
  const toggleBtn = document.querySelector(".theme-toggle");
  if (!toggleBtn) return;

  const updateToggleIcon = (theme) => {
    toggleBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  };

  // The initial state is loaded early in the HTML head script, but sync it here
  const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
  updateToggleIcon(currentTheme);

  toggleBtn.addEventListener("click", () => {
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    updateToggleIcon(theme);

    // If Scalar explorer exists, reinitialize with new theme
    const scalarHost = document.getElementById("scalar-host");
    if (scalarHost && typeof Scalar !== 'undefined') {
      scalarHost.innerHTML = '';
      Scalar.createApiReference('#scalar-host', {
        spec: { url: '/docs/openapi.yaml' },
        configuration: {
          layout: 'modern',
          hideDownloadButton: false,
          darkMode: theme !== 'light',
        },
      });
    }
  });
}

// ── Copy-to-Clipboard & Formatting ────────────────────────
function initCodeBlocks() {
  const preElements = document.querySelectorAll("pre");

  preElements.forEach(pre => {
    // Skip if already initialized
    if (pre.querySelector(".pre-header")) return;

    // Detect language or label
    const code = pre.querySelector("code");
    let lang = "TEXT";
    if (code) {
      const classes = code.className || "";
      if (classes.includes("language-")) {
        // Extract language from class
        const match = classes.match(/language-(\S+)/);
        if (match) lang = match[1].toUpperCase();
      } else {
        // Fallbacks based on content & auto-assign language class
        const text = code.textContent || "";
        if (text.startsWith("curl ") || text.includes("\\\n") || text.startsWith("docker ") || text.startsWith("bun ") || text.startsWith("npm ")) {
          lang = "BASH";
          code.classList.add("language-bash");
        } else if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
          lang = "JSON";
          code.classList.add("language-json");
        } else if (text.startsWith("import ") || text.startsWith("const ") || text.includes("interface ") || text.includes("async ")) {
          lang = "TS";
          code.classList.add("language-typescript");
        } else if (text.includes("scrape_configs:") || text.includes("job_name:")) {
          lang = "YAML";
          code.classList.add("language-yaml");
        } else if (text.startsWith("type Query") || text.startsWith("type Mutation")) {
          lang = "GRAPHQL";
          code.classList.add("language-graphql");
        } else if (text.includes("SELECT ") || text.includes("CREATE TABLE")) {
          lang = "SQL";
          code.classList.add("language-sql");
        } else if (text.includes("def ") || text.includes("import ") || text.includes("client = ")) {
          lang = "PYTHON";
          code.classList.add("language-python");
        }
      }
    }

    // Build header
    const header = document.createElement("div");
    header.className = "pre-header";
    header.innerHTML = `
      <div class="pre-dots">
        <span></span><span></span><span></span>
      </div>
      <span class="pre-lang">${lang}</span>
      <button class="copy-btn">Copy</button>
    `;

    pre.insertBefore(header, pre.firstChild);

    // Hook copy button
    const copyBtn = header.querySelector(".copy-btn");
    copyBtn.addEventListener("click", () => {
      const textToCopy = code ? code.textContent : pre.innerText;
      // Strip heading elements if they got copied
      navigator.clipboard.writeText(textToCopy).then(() => {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 2000);
      });
    });
  });

  // Apply syntax highlighting if highlight.js is loaded
  if (typeof hljs !== "undefined") {
    document.querySelectorAll("pre code[class*='language-']").forEach((block) => {
      hljs.highlightElement(block);
    });
  }
}

// ── Heading Anchors ──────────────────────────────────────
function initHeadingAnchors() {
  const headings = document.querySelectorAll(".main h2[id], .main h3[id]");
  headings.forEach(heading => {
    if (heading.querySelector(".anchor")) return;

    const id = heading.getAttribute("id");
    const anchor = document.createElement("a");
    anchor.className = "anchor";
    anchor.setAttribute("href", `#${id}`);
    anchor.textContent = "#";
    heading.appendChild(anchor);
  });
}

// ── Scroll Progress & ScrollSpy ──────────────────────────
function initScrollProgress() {
  const bar = document.getElementById("scroll-progress");
  if (!bar) return;

  window.addEventListener("scroll", () => {
    const winScroll = document.documentElement.scrollTop || document.body.scrollTop;
    const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const scrolled = height > 0 ? (winScroll / height) * 100 : 0;
    bar.style.width = scrolled + "%";
  });
}

// ── ScrollSpy — Highlights sidebar item as user scrolls ──
function initScrollSpy() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  // Collect all headings with IDs from the main content
  const headings = document.querySelectorAll(".main h2[id], .main h3[id]");
  if (headings.length === 0) return;

  const pathname = window.location.pathname.split("#")[0].split("?")[0].replace(/\.html$/, "").replace(/\/$/, "");

  // Build a map: heading ID → sidebar link element
  const sidebarLinks = sidebar.querySelectorAll("a[data-sidebar-href]");
  const hashToLink = new Map();
  let baseLinkEl = null;

  sidebarLinks.forEach(link => {
    const href = link.getAttribute("data-sidebar-href");
    const [linkBase, linkHash] = splitHref(href);
    const cleanBase = linkBase.replace(/\.html$/, "").replace(/\/$/, "");

    // Only track links for the current page
    if (cleanBase !== pathname && !(cleanBase === "/docs" && (pathname === "/docs" || pathname === "/docs/index"))) return;

    if (linkHash) {
      hashToLink.set(linkHash, link);
    } else {
      baseLinkEl = link;
    }
  });

  // If there are no matching sidebar links, nothing to spy on
  if (hashToLink.size === 0 && !baseLinkEl) return;

  function clearActive() {
    sidebarLinks.forEach(l => l.classList.remove("active"));
  }

  function setActive(headingId) {
    clearActive();
    if (headingId && hashToLink.has(headingId)) {
      hashToLink.get(headingId).classList.add("active");
      // Scroll the sidebar link into view if needed
      const activeLink = hashToLink.get(headingId);
      scrollSidebarToActive(activeLink);
    } else if (baseLinkEl) {
      baseLinkEl.classList.add("active");
    }
  }

  // Use IntersectionObserver with rootMargin to detect which heading is "in view"
  // We consider a heading "active" when it crosses the top portion of the viewport
  let currentActiveId = null;

  const observer = new IntersectionObserver(
    (entries) => {
      // Process entries to find the topmost visible heading
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          currentActiveId = entry.target.getAttribute("id");
          setActive(currentActiveId);
        }
      });
    },
    {
      // Trigger when heading is near the top of the viewport
      rootMargin: "-80px 0px -70% 0px",
      threshold: 0,
    }
  );

  headings.forEach(h => observer.observe(h));

  // Also handle scroll-to-top: if user is at the very top, highlight the base link
  let scrollTimeout;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      if (window.scrollY < 100 && baseLinkEl) {
        clearActive();
        baseLinkEl.classList.add("active");
        currentActiveId = null;
      }
    }, 50);
  });

  // Handle hashchange events (when user clicks sidebar links or uses browser back/forward)
  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.slice(1);
    if (hash && hashToLink.has(hash)) {
      clearActive();
      hashToLink.get(hash).classList.add("active");
      scrollSidebarToActive(hashToLink.get(hash));
    } else if (!hash && baseLinkEl) {
      clearActive();
      baseLinkEl.classList.add("active");
    }
  });
}

/**
 * Scrolls the sidebar so the active link is visible
 */
function scrollSidebarToActive(activeLink) {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar || !activeLink) return;

  const sidebarRect = sidebar.getBoundingClientRect();
  const linkRect = activeLink.getBoundingClientRect();

  // If the link is outside the visible sidebar area, scroll to it
  if (linkRect.top < sidebarRect.top + 60 || linkRect.bottom > sidebarRect.bottom - 40) {
    activeLink.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
