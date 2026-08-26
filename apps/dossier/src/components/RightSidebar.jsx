// src/components/RightSidebar.jsx
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate, Link } from "react-router-dom";
import {
  Copy,
  Check,
  HeartHandshake,
  X,
  AlertTriangle,
  LifeBuoy,
  MapPin,
  ChevronRight,
  EyeOff,
} from "lucide-react";
import useLensViolations from "../hooks/useLensViolations";
import { useLensHelpRequests } from "../hooks/useLensHelpRequests";
// ADDED: the same sanction/moderation flow used on ViolationsListPage.jsx /
// SupportPage.jsx / ViolationsSlideshow.jsx / HelpRequestsSlideshow.jsx —
// RightSidebar renders "Violations" and "Help requests" with entirely
// separate code (its own loadViolations, its own useLensHelpRequests), so
// until now no sanction ever reached it here.
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

// ─── Constants ────────────────────────────────────────────────────────────────
const REFRESH_MS = 5 * 60 * 1000;
const PAGE_SIZE = 3;
const ROTATE_MS = 6000;
const SLIDE_MS = 400; // duration of the CSS transition
// ADDED: poll for sanctions more often and separately from REFRESH_MS, as elsewhere.
const MOD_REFRESH_MS = 60 * 1000;

// ─── Design tokens (CSS variables for light/dark theme support) ─────────────
const T = {
  surfaceHov: "var(--rs-surface-hov)",
  border: "var(--rs-border)",
  text1: "var(--rs-text1)",
  text3: "var(--rs-text3)",
  red: "#e53935",
  redBg: "rgba(248,113,113,0.09)",
  redBd: "rgba(248,113,113,0.2)",
  blue: "#60a5fa",
  blueBg: "rgba(96,165,250,0.09)",
  blueBd: "rgba(96,165,250,0.2)",
  green: "#059669",
  greenBg: "rgba(52,211,153,0.09)",
  greenBd: "rgba(52,211,153,0.2)",
};

const authorHandle = (a) => {
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object")
    return a.unique_name || a.handle || a.username || a.id || "";
  return String(a);
};

// ─── CSS ──────────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @keyframes spin_ { to { transform: rotate(360deg); } }

  /* ── Light theme (default and explicit) ── */
  /* :root = light by default; html:not(.dark) overrides the system dark theme */
  :root,
  html:not(.dark),
  html.light {
    --rs-surface-hov: rgba(0,0,0,0.045);
    --rs-border: rgba(0,0,0,0.12);
    --rs-text1: rgba(15,23,42,0.92);
    --rs-text3: rgba(15,23,42,0.58);
    --rs-modal-bg: #ffffff;
    --rs-modal-border: rgba(0,0,0,0.12);
    --rs-avatar-bg: rgba(0,0,0,0.04);
    --rs-close-bg: rgba(0,0,0,0.06);
    --rs-close-bg-hov: rgba(0,0,0,0.12);
    --rs-footer-border: rgba(0,0,0,0.1);
    --rs-overlay: rgba(0,0,0,0.55);
  }

  /* ── Dark theme ── */
  /* Tailwind adds .dark to <html>, so we cover all variants */
  html.dark,
  html.dark body,
  .dark {
    --rs-surface-hov: rgba(255,255,255,0.055);
    --rs-border: rgba(255,255,255,0.07);
    --rs-text1: rgba(255,255,255,0.82);
    --rs-text3: rgba(255,255,255,0.22);
    --rs-modal-bg: #080e1a;
    --rs-modal-border: rgba(255,255,255,0.09);
    --rs-avatar-bg: rgba(255,255,255,0.04);
    --rs-close-bg: rgba(255,255,255,0.05);
    --rs-close-bg-hov: rgba(255,255,255,0.10);
    --rs-footer-border: rgba(255,255,255,0.06);
    --rs-overlay: rgba(0,0,0,0.75);
  }

  /* ── Skeleton animation ── */
  @keyframes shimmer {
    0% { background-position: -200px 0; }
    100% { background-position: calc(200px + 100%) 0; }
  }
  .skeleton-line {
    background: var(--rs-border);
    border-radius: 4px;
    background-image: linear-gradient(
      90deg,
      var(--rs-border) 0%,
      var(--rs-surface-hov) 40%,
      var(--rs-border) 80%
    );
    background-size: 200px 100%;
    background-repeat: no-repeat;
    animation: shimmer 1.5s ease-in-out infinite;
  }
`;

// ─── SkeletonRow ─────────────────────────────────────────────────────────────
const SkeletonRow = ({ height }) => (
  <div
    style={{
      height,
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 12px",
      flexShrink: 0,
    }}
  >
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        className="skeleton-line"
        style={{ height: 14, width: "85%", borderRadius: 4 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          className="skeleton-line"
          style={{ height: 9, width: 9, borderRadius: "50%", flexShrink: 0 }}
        />
        <div
          className="skeleton-line"
          style={{ height: 10, width: "45%", borderRadius: 4 }}
        />
        <div
          className="skeleton-line"
          style={{ height: 10, width: 30, borderRadius: 4, marginLeft: "auto" }}
        />
      </div>
    </div>
  </div>
);

// ─── SidebarRow ───────────────────────────────────────────────────────────────
// A shared row "shape" for the "Violations" and "Help requests" sections:
// title (2 lines) → second line [icon/avatar + text ... time].
// No colored lines or badges — identical appearance for both sections.
const SidebarRow = ({
  onClick,
  title,
  secondaryIcon,
  secondaryText,
  blurred,
}) => {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "7px 12px",
        background: hov ? T.surfaceHov : "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        transition: "background 0.1s",
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* ADDED: when blurred — the title gets blurred (filter: blur),
            and the second line is replaced with a sanction marker instead
            of the address/author. The row's height doesn't change —
            SlideSection computes the window based on a fixed rowHeight, an
            extra line would break the slide. hidden never reaches here at
            all — such items are already filtered out above, before
            SlideSection. */}
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: T.text1,
            lineHeight: 1.4,
            marginBottom: 3,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            filter: blurred ? "blur(3px)" : "none",
            userSelect: blurred ? "none" : "auto",
          }}
        >
          {title}
        </div>
        {blurred ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <EyeOff size={9} color={T.text3} style={{ flexShrink: 0 }} />
            <span
              style={{
                fontSize: 12,
                color: T.text3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {"Flagged by a moderator"}
            </span>
          </div>
        ) : (
          (secondaryIcon || secondaryText) && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {secondaryIcon}
              {secondaryText && (
                <span
                  style={{
                    fontSize: 12,
                    color: T.text3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {secondaryText}
                </span>
              )}
            </div>
          )
        )}
      </div>
    </button>
  );
};

// ─── ViolationRow ─────────────────────────────────────────────────────────────
const ViolationRow = ({ item, onClick }) => {
  return (
    <SidebarRow
      onClick={onClick}
      title={item.title}
      secondaryIcon={
        <MapPin size={9} color={T.text3} style={{ flexShrink: 0 }} />
      }
      secondaryText={item.location}
      blurred={item.blurred}
    />
  );
};

// ─── HelpRow ──────────────────────────────────────────────────────────────────
const HelpRow = ({ item, onClick }) => {
  const handle = authorHandle(item.author);
  return (
    <SidebarRow
      onClick={onClick}
      title={item.title}
      secondaryText={handle ? `@${handle}` : null}
      blurred={item.blurred}
    />
  );
};

// ─── SlideSection ─────────────────────────────────────────────────────────────
// Renders exactly PAGE_SIZE rows in a fixed-height window.
// Slide from bottom to top: two "frames" (current + next) are laid out
// vertically, translateY shifts them upward during the transition.
const SlideSection = ({
  icon: Icon,
  label,
  color,
  items,
  loading,
  emptyText,
  renderRow,
  onAll,
  rowHeight,
}) => {
  const { t } = useTranslation();
  const total = Math.ceil(items.length / PAGE_SIZE);
  const [page, setPage] = useState(0);
  const [sliding, setSliding] = useState(false); // true = animation in progress
  const [nextPage, setNextPage] = useState(1);
  const timerRef = useRef(null);

  // reset when the data changes
  useEffect(() => {
    setPage(0);
    setSliding(false);
  }, [items.length]);

  const startSlide = useCallback(() => {
    if (total <= 1) return;
    const np = (page + 1) % total;
    setNextPage(np);
    setSliding(true);
    // once the CSS transition finishes, commit the new page
    setTimeout(() => {
      setPage(np);
      setSliding(false);
    }, SLIDE_MS);
  }, [page, total]);

  useEffect(() => {
    if (total <= 1) return;
    timerRef.current = setInterval(startSlide, ROTATE_MS);
    return () => clearInterval(timerRef.current);
  }, [startSlide, total]);

  const getSlice = (p) => {
    const base = items.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
    // if there are fewer rows than PAGE_SIZE — pad with empty
    // placeholders so the container's height doesn't jump
    while (base.length < PAGE_SIZE) base.push(null);
    return base;
  };

  const currentSlice = getSlice(page);
  const nextSlice = getSlice(nextPage);

  // Window height = rowHeight * PAGE_SIZE
  const windowH = rowHeight * PAGE_SIZE;

  return (
    <div>
      {/* Title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "0 12px 6px",
        }}
      >
        <Icon size={11} color={color} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: T.text3,
            flex: 1,
          }}
        >
          {label}
        </span>
        {items.length > 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "1px 5px",
              borderRadius: 4,
              background:
                color === T.red
                  ? T.redBg
                  : color === T.green
                    ? T.greenBg
                    : T.blueBg,
              color,
            }}
          >
            {items.length}
          </span>
        )}
        {onAll && (
          <button
            onClick={onAll}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.text3,
              padding: 0,
              transition: "color 0.1s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.text1)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.text3)}
          >
            <span style={{ fontSize: 12 }}>{t("view_all")}</span>
            <ChevronRight size={10} />
          </button>
        )}
      </div>

      {/* Loading — skeletons */}
      {loading && (
        <div style={{ height: windowH }}>
          {Array.from({ length: PAGE_SIZE }).map((_, i) => (
            <SkeletonRow key={`skeleton-${i}`} height={rowHeight} />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && items.length === 0 && (
        <div
          style={{
            height: windowH,
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
          }}
        >
          <span style={{ fontSize: 13, color: T.text3 }}>{emptyText}</span>
        </div>
      )}

      {/* Slide window */}
      {!loading && items.length > 0 && (
        <div
          style={{
            height: windowH,
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Track: current frame on top, next below */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: sliding
                ? `translateY(-${windowH}px)`
                : "translateY(0)",
              transition: sliding
                ? `transform ${SLIDE_MS}ms cubic-bezier(0.4,0,0.2,1)`
                : "none",
              willChange: "transform",
            }}
          >
            {/* Current frame */}
            <div style={{ height: windowH }}>
              {currentSlice.map((item, i) =>
                item ? (
                  renderRow(item)
                ) : (
                  <div key={`ph-${i}`} style={{ height: rowHeight }} />
                ),
              )}
            </div>
            {/* Next frame (hidden below) */}
            <div style={{ height: windowH }}>
              {nextSlice.map((item, i) =>
                item ? (
                  renderRow(item)
                ) : (
                  <div key={`ph2-${i}`} style={{ height: rowHeight }} />
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── SupportModal ─────────────────────────────────────────────────────────────
const SupportModal = ({ t, onClose }) => {
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  // NOTE: addresses intentionally left blank before the public GitHub release.
  // Fill in real donation addresses here once they're finalized, then remove
  // this comment.
  const wallets = [
    {
      type: "ethereum",
      label: "ETH",
      name: "Ethereum",
      address: "",
      color: "#818cf8",
      bg: "rgba(129,140,248,0.1)",
      bd: "rgba(129,140,248,0.2)",
    },
    {
      type: "bitcoin",
      label: "BTC",
      name: "Bitcoin",
      address: "",
      color: "#fb923c",
      bg: "rgba(251,146,60,0.1)",
      bd: "rgba(251,146,60,0.2)",
    },
    {
      type: "ton",
      label: "TON",
      name: "TON",
      address: "",
      color: "#38bdf8",
      bg: "rgba(56,189,248,0.1)",
      bd: "rgba(56,189,248,0.2)",
    },
    {
      type: "solana",
      label: "SOL",
      name: "Solana",
      address: "",
      color: "#c084fc",
      bg: "rgba(192,132,252,0.1)",
      bd: "rgba(192,132,252,0.2)",
    },
    {
      type: "tether",
      label: "USDT",
      name: "Tether ERC-20",
      address: "",
      color: "#34d399",
      bg: "rgba(52,211,153,0.1)",
      bd: "rgba(52,211,153,0.2)",
    },
  ];

  const copy = (address, type) => {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--rs-overlay)",
        backdropFilter: "blur(8px)",
        padding: "0 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--rs-modal-bg)",
          border: "1px solid var(--rs-modal-border)",
          borderRadius: 18,
          overflow: "hidden",
          boxShadow: "0 40px 100px rgba(0,0,0,0.8)",
        }}
      >
        <div
          style={{
            padding: "18px 18px 14px",
            borderBottom: "1px solid var(--rs-footer-border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: T.greenBg,
              border: `1px solid ${T.greenBd}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <HeartHandshake size={15} color={T.green} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: T.text1 }}>
              {t("support_development") || "Support the project"}
            </div>
            <div style={{ fontSize: 12, color: T.text3, marginTop: 1 }}>
              HRP DAO · human rights on the blockchain
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "var(--rs-close-bg)",
              border: "1px solid var(--rs-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: T.text3,
              transition: "all 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--rs-close-bg-hov)";
              e.currentTarget.style.color = T.text1;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--rs-close-bg)";
              e.currentTarget.style.color = T.text3;
            }}
          >
            <X size={12} />
          </button>
        </div>
        <div style={{ padding: "14px 18px 18px" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: T.text3,
              marginBottom: 8,
            }}
          >
            {t("cryptocurrencies") || "Cryptocurrencies"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {wallets.map((w) => {
              const isCopied = copied === w.type;
              const hasAddress = Boolean(w.address);
              return (
                <button
                  key={w.type}
                  onClick={() => copy(w.address, w.type)}
                  disabled={!hasAddress}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 11px",
                    borderRadius: 10,
                    width: "100%",
                    background: isCopied ? T.greenBg : w.bg,
                    border: `1px solid ${isCopied ? T.greenBd : w.bd}`,
                    cursor: hasAddress ? "pointer" : "not-allowed",
                    opacity: hasAddress ? 1 : 0.5,
                    textAlign: "left",
                    transition: "filter 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isCopied && hasAddress)
                      e.currentTarget.style.filter =
                        "var(--rs-wallet-btn-hov, brightness(1.3))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.filter = "";
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: "2px 6px",
                      borderRadius: 5,
                      background: w.bg,
                      color: w.color,
                      border: `1px solid ${w.bd}`,
                      flexShrink: 0,
                      minWidth: 34,
                      textAlign: "center",
                    }}
                  >
                    {w.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}
                    >
                      {w.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: T.text3,
                        fontFamily: "monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginTop: 1,
                      }}
                    >
                      {w.address || t("address_coming_soon") || "Coming soon"}
                    </div>
                  </div>
                  <div
                    style={{
                      color: isCopied ? T.green : T.text3,
                      flexShrink: 0,
                      transition: "color 0.12s",
                    }}
                  >
                    {hasAddress ? (
                      isCopied ? (
                        <Check size={13} />
                      ) : (
                        <Copy size={13} />
                      )
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ─── RightSidebar ─────────────────────────────────────────────────────────────
const RightSidebar = ({ activeRightMenu, onRightMenuClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // CHANGED: rawViolations — raw violations (rebuilt only when new data
  // has actually arrived from fetchViolations). The visible violations
  // list is a separate derived layer (useMemo below) that accounts for
  // modActions without a reshuffle/rebuild on every 60s sanction poll.
  const [rawViolations, setRawViolations] = useState([]);
  const [vLoading, setVLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const { fetchViolations } = useLensViolations();

  // ADDED: one shared fetchAllModActions() for the whole sidebar (both
  // "Violations" and "Help requests" count sanctions from the same
  // array — following the same principle used on ViolationsListPage/SupportPage).
  const [modActions, setModActions] = useState([]);
  // ADDED: totalSupply() of the Shield SBT directly from the blockchain
  // (the same fix already applied on FollowingPage.jsx/CountryFeed.jsx/
  // ViolationsListPage.jsx/SupportPage.jsx/ModerationQueue.jsx) —
  // dao.shieldInfo?.totalSupply is only populated after dao.connect(),
  // which a sidebar visitor never triggers.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  // ADDED: while modActions/shieldTotalSupply hasn't loaded yet, the
  // list's first render happened WITHOUT the ban filter — meaning a
  // banned author's posts briefly appeared, then disappeared once the
  // data finished loading. modReady keeps the sections in a "loading"
  // state until sanctions have been computed at least once.
  const [modReady, setModReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadModActions = async () => {
      try {
        const [actions, supply] = await Promise.all([
          fetchAllModActions(),
          fetchShieldTotalSupply(),
        ]);
        if (!cancelled) {
          setModActions(actions);
          setShieldTotalSupply(supply);
        }
      } catch (err) {
        console.warn("⚠️ Could not load moderation actions:", err.message);
      } finally {
        if (!cancelled) setModReady(true);
      }
    };
    loadModActions();
    const modInterval = setInterval(loadModActions, MOD_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(modInterval);
    };
  }, []);

  const loadViolations = useCallback(async () => {
    try {
      const result = await fetchViolations({});
      if (!result.success) return;
      setRawViolations(
        result.violations.map((c) => ({
          id: c.id,
          // ADDED: needed for computeModerationState() — sanctions are
          // tied to lens_post_id, the same as on ViolationsListPage.
          lensPostId: c.lens_post_id,
          // ADDED: needed for computeBanState() below — previously the
          // author's address wasn't stored here at all, so there was
          // nothing to check the ban against.
          authorOwnerAddress: c.author?.owner_address || null,
          title: c.title,
          location: c.address || c.country_code || "",
          severity: c.severity || "mid",
        })),
      );
    } catch (e) {
      console.error("loadViolations:", e);
    } finally {
      setVLoading(false);
    }
  }, [fetchViolations]);

  useEffect(() => {
    loadViolations();
    const id = setInterval(loadViolations, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadViolations]);

  // CHANGED: hidden violations are excluded from the sidebar entirely,
  // blurred ones remain with a flag for the blur style in SidebarRow.
  const violations = useMemo(() => {
    return rawViolations
      .map((v) => {
        const modState = computeModerationState(modActions, v.lensPostId);
        return { ...v, ...modState };
      })
      .filter((v) => !v.hidden)
      // ADDED: posts by authors whose account has been banned by vote
      // are not shown at all — previously this section only checked
      // hide/blur, but not the author's ban.
      .filter((v) => {
        if (!v.authorOwnerAddress) return true;
        const banState = computeBanState(
          modActions,
          v.authorOwnerAddress,
          shieldTotalSupply,
        );
        return !banState.banned;
      });
  }, [rawViolations, modActions, shieldTotalSupply]);

  const {
    requests: lensRequests,
    loading: hLoading,
    loadRequests,
  } = useLensHelpRequests();

  // CHANGED: the same moderation layer for help requests — hidden is
  // excluded, blurred is flagged for HelpRow/SidebarRow.
  const helpRequests = useMemo(
    () =>
      [...lensRequests]
        .sort(
          (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
        )
        .map((r) => {
          const primaryType = (r.help_types || [])[0] || null;
          const modState = computeModerationState(modActions, r.lens_post_id);
          return {
            id: r.id,
            title: r.title,
            category: primaryType,
            author: r.author || r.handle || r.lens_handle || null,
            authorOwnerAddress: r.author?.owner_address || null,
            extraTypes: Math.max(0, (r.help_types?.length || 0) - 1),
            ...modState,
          };
        })
        .filter((r) => !r.hidden)
        // ADDED: the same thing — exclude requests from banned authors.
        .filter((r) => {
          if (!r.authorOwnerAddress) return true;
          const banState = computeBanState(
            modActions,
            r.authorOwnerAddress,
            shieldTotalSupply,
          );
          return !banState.banned;
        }),
    [lensRequests, modActions, shieldTotalSupply],
  );

  useEffect(() => {
    loadRequests();
    const id = setInterval(loadRequests, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadRequests]);

  // Row height (px) — the structure is the same for both sections:
  // title (2 lines ~40px) + icon+text row (~18px) + padding (14px)
  const V_ROW_H = 72;
  const H_ROW_H = 72;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <style>{GLOBAL_CSS}</style>

      {/* ── Content without scroll ── */}
      <div style={{ flex: 1, overflow: "hidden", padding: "14px 0 6px" }}>
        <SlideSection
          icon={AlertTriangle}
          label={t("violations") || "Violations"}
          color={T.red}
          items={violations}
          loading={vLoading || !modReady}
          emptyText={t("no_violations") || "No violations yet"}
          onAll={() => navigate("/violations-list")}
          rowHeight={V_ROW_H}
          renderRow={(item) => (
            <ViolationRow
              key={item.id}
              item={item}
              onClick={() => navigate(`/violations/${item.id}`)}
            />
          )}
        />

        <div style={{ height: 1, background: T.border, margin: "6px 0" }} />

        <SlideSection
          icon={LifeBuoy}
          label={t("help_requests") || "Help requests"}
          color={T.green}
          items={helpRequests}
          loading={hLoading || !modReady}
          emptyText={t("no_help_requests") || "No requests yet"}
          onAll={() => navigate("/help-list")}
          rowHeight={H_ROW_H}
          renderRow={(item) => (
            <HelpRow
              key={item.id}
              item={item}
              onClick={() => navigate(`/help/${item.id}`)}
            />
          )}
        />
      </div>

      {/* ── Footer ── */}
      <div
        style={{
          padding: "10px 10px 12px",
          borderTop: `1px solid var(--rs-footer-border)`,
        }}
      >
        <button
          onClick={() => setShowModal(true)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 12px",
            borderRadius: 9,
            background: T.blueBg,
            border: `1px solid ${T.blueBd}`,
            color: T.blue,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.15s",
            marginBottom: 8,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(96,165,250,0.15)";
            e.currentTarget.style.borderColor = "rgba(96,165,250,0.35)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = T.blueBg;
            e.currentTarget.style.borderColor = T.blueBd;
          }}
        >
          <HeartHandshake size={13} />
          {t("support_development") || "Support the project"}
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontSize: 11,
            marginBottom: 4,
          }}
        >
          {[
            { to: "/about", label: t("footer_about") || "About" },
            { to: "/terms", label: t("footer_terms") || "Terms" },
            { to: "/privacy", label: t("footer_privacy") || "Privacy" },
          ].map((link, i) => (
            <React.Fragment key={link.to}>
              {i > 0 && <span style={{ color: T.text3 }}>·</span>}
              <Link
                to={link.to}
                style={{
                  color: T.text3,
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >
                {link.label}
              </Link>
            </React.Fragment>
          ))}
        </div>
        <div style={{ fontSize: 12, color: T.text3, textAlign: "center" }}>
          © {new Date().getFullYear()} HRP DAO · All rights reserved
        </div>
      </div>

      {showModal && <SupportModal t={t} onClose={() => setShowModal(false)} />}
    </div>
  );
};

export default RightSidebar;