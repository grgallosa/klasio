import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Upload, Loader2, RotateCcw, AlertCircle, Download, Pencil, Check, X,
  Trash2, Plus, GripVertical, CalendarDays, AlertTriangle, CheckCircle2,
} from "lucide-react";

const INK = "#111111";
const GRAY = "#666666";
const LIGHT_GRAY = "#EFEFEF";
const RULE = "#DEDEDE";
const HILITE = "#F5F5F5";
const DANGER = "#B3261E";
const DANGER_BG = "#FBEAE9";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};
const DAY_ALIASES = {
  monday: "Mon", mon: "Mon", m: "Mon",
  tuesday: "Tue", tue: "Tue", tu: "Tue", t: "Tue",
  wednesday: "Wed", wed: "Wed", w: "Wed",
  thursday: "Thu", thu: "Thu", th: "Thu",
  friday: "Fri", fri: "Fri", f: "Fri",
  saturday: "Sat", sat: "Sat", s: "Sat",
  sunday: "Sun", sun: "Sun", su: "Sun",
};
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const STORAGE_KEY = "schedule-v1";
const MAX_UPLOADS = 3;
const UPLOAD_COUNT_KEY = "schedule-upload-count";

// Simple localStorage-backed persistence (this app has no server-side
// database — everything lives in the visitor's own browser).
const storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? null : { key, value };
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};

function normalizeDay(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return DAY_ALIASES[key] || null;
}

function parseTimeToMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (h > 23 || min > 59) return null;
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (!ampm && h <= 7) h += 12; // bare "1:00" in a class schedule usually means PM
  return h * 60 + min;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

// Tries to downscale/compress the image via canvas. If anything in that
// pipeline fails, we fall back to sending the original file untouched
// rather than blocking the upload.
async function resizeImageFile(file, maxDim = 1568, quality = 0.85) {
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const el = document.createElement("img");
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode image"));
      el.src = dataUrl;
    });

    let { naturalWidth: width, naturalHeight: height } = img;
    if (!width || !height) throw new Error("Image has no dimensions");

    if (width <= maxDim && height <= maxDim) {
      return { base64: dataUrl.split(",")[1], mediaType: file.type || "image/jpeg", previewUrl: dataUrl };
    }

    if (width > height) {
      height = Math.round(height * (maxDim / width));
      width = maxDim;
    } else {
      width = Math.round(width * (maxDim / height));
      height = maxDim;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(img, 0, 0, width, height);
    const resizedUrl = canvas.toDataURL("image/jpeg", quality);
    return { base64: resizedUrl.split(",")[1], mediaType: "image/jpeg", previewUrl: resizedUrl };
  } catch (e) {
    console.error("Resize pipeline failed, falling back to original file:", e);
    const dataUrl = await readFileAsDataUrl(file);
    return { base64: dataUrl.split(",")[1], mediaType: file.type || "image/jpeg", previewUrl: dataUrl };
  }
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    const candidate = match ? match[0] : cleaned;
    try {
      return JSON.parse(candidate);
    } catch (e2) {
      // Response likely got cut off mid-object (token limit). Salvage
      // whatever complete entries we can instead of failing outright.
      const lastComplete = candidate.lastIndexOf("},");
      if (lastComplete > -1) {
        try {
          return JSON.parse(candidate.slice(0, lastComplete + 1) + "]");
        } catch (e3) {
          // fall through
        }
      }
      throw new Error("incomplete-response");
    }
  }
}

const emptyDraft = { course: "", start: "", end: "", room: "", instructor: "", day: "Mon" };

export default function App() {
  const [imageData, setImageData] = useState(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [courses, setCourses] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [exportReady, setExportReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [addingDay, setAddingDay] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [draftError, setDraftError] = useState(null);
  const [dragOverDay, setDragOverDay] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [toast, setToast] = useState(null);
  const [uploadCount, setUploadCount] = useState(0);

  const fileInputRef = useRef(null);
  const scheduleRef = useRef(null);
  const draggingIdRef = useRef(null);
  const dragOverDayRef = useRef(null);

  // ---- toast ----
  const showToast = useCallback((message, kind = "success") => {
    setToast({ message, kind, key: makeId() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- load html2canvas for export ----
  useEffect(() => {
    if (window.html2canvas) {
      setExportReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.async = true;
    script.onload = () => setExportReady(true);
    script.onerror = () => setExportReady(false);
    document.body.appendChild(script);
  }, []);

  // ---- restore saved schedule + upload count ----
  useEffect(() => {
    (async () => {
      try {
        const saved = await storage.get(STORAGE_KEY);
        if (saved && saved.value) {
          const parsed = JSON.parse(saved.value);
          if (Array.isArray(parsed)) {
            setCourses(parsed.map((c) => ({ ...c, id: c.id || makeId() })));
          }
        }
      } catch (e) {
        // no saved schedule yet — that's fine
      }
      try {
        const savedCount = await storage.get(UPLOAD_COUNT_KEY);
        const n = savedCount ? parseInt(savedCount.value, 10) : 0;
        setUploadCount(Number.isFinite(n) ? n : 0);
      } catch (e) {
        // treat as zero
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setCourses(next);
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      showToast("Saved in this tab, but couldn't write to storage. Changes may not survive a refresh.", "error");
    }
  }, [showToast]);

  // ---- file upload ----
  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image. Please upload a photo, scan, or screenshot.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("That image is too large (max 15MB). Try a smaller photo or a screenshot.");
      return;
    }
    setImageProcessing(true);
    try {
      const { base64, mediaType, previewUrl } = await resizeImageFile(file);
      setImageData({ base64, mediaType, previewUrl });
    } catch (e) {
      setError("Couldn't process that image. Try a different file.");
    } finally {
      setImageProcessing(false);
    }
  }, []);

  const onInputChange = (e) => handleFile(e.target.files?.[0]);
  const onDropZoneDrop = (e) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files?.[0]);
  };

  const runExtraction = async () => {
    if (!imageData) return;
    if (uploadCount >= MAX_UPLOADS) {
      setError(`You've used all ${MAX_UPLOADS} uploads for this browser.`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: imageData.base64, mediaType: imageData.mediaType }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      if (!data.text) throw new Error("No response from model");

      const parsed = extractJsonArray(data.text);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setError("No schedule found in that image. Try a clearer, well-lit photo, or a different page.");
        return;
      }

      const cleaned = parsed
        .map((c) => ({
          id: makeId(),
          day: normalizeDay(c.day),
          start: (c.start || "").trim(),
          end: (c.end || "").trim(),
          course: (c.course || "Untitled").trim(),
          room: (c.room || "").trim(),
          instructor: (c.instructor || "").trim(),
        }))
        .filter((c) => c.day);

      if (cleaned.length === 0) {
        setError("Found text, but couldn't match it to specific days. Try a clearer photo.");
        return;
      }

      const existing = courses || [];
      await persist([...existing, ...cleaned]);
      setImageData(null);
      const nextCount = uploadCount + 1;
      setUploadCount(nextCount);
      storage.set(UPLOAD_COUNT_KEY, String(nextCount)).catch(() => {});
      showToast(`Added ${cleaned.length} class${cleaned.length === 1 ? "" : "es"}.`);
    } catch (e) {
      console.error(e);
      const friendly = e.message === "incomplete-response"
        ? "The schedule was too long for one pass — try a photo with fewer classes, or split it into two uploads."
        : (e.message && e.message !== "Failed to fetch" ? e.message : "Couldn't read that schedule. Check your connection and try again.");
      setError(friendly);
    } finally {
      setLoading(false);
    }
  };

  const clearAll = async () => {
    setImageData(null);
    setError(null);
    setEditingId(null);
    setAddingDay(null);
    await persist([]);
    showToast("Schedule cleared.");
  };

  const downloadImage = async (format) => {
    if (!scheduleRef.current || !window.html2canvas) {
      showToast("Export isn't ready yet — try again in a moment.", "error");
      return;
    }
    setExporting(true);
    try {
      const canvas = await window.html2canvas(scheduleRef.current, { backgroundColor: "#ffffff", scale: 2 });
      const mime = format === "jpg" ? "image/jpeg" : "image/png";
      const url = canvas.toDataURL(mime, 0.95);
      const link = document.createElement("a");
      link.download = `schedule.${format}`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast(`Downloaded as ${format.toUpperCase()}.`);
    } catch (e) {
      console.error(e);
      showToast("Couldn't export the image. Try again.", "error");
    } finally {
      setExporting(false);
    }
  };

  // ---- validation ----
  const validateDraft = (d) => {
    if (!d.course.trim()) return "Course name is required.";
    if (d.start && !parseTimeToMinutes(d.start)) return 'Start time format not recognized (try "9:00 AM").';
    if (d.end && !parseTimeToMinutes(d.end)) return 'End time format not recognized (try "10:30 AM").';
    if (d.start && d.end) {
      const s = parseTimeToMinutes(d.start);
      const en = parseTimeToMinutes(d.end);
      if (s != null && en != null && en <= s) return "End time should be after start time.";
    }
    return null;
  };

  // ---- edit / add / delete ----
  const startEdit = (c) => {
    setAddingDay(null);
    setEditingId(c.id);
    setDraftError(null);
    setDraft({ course: c.course, start: c.start, end: c.end, room: c.room, instructor: c.instructor, day: c.day });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraftError(null);
    setDraft(emptyDraft);
  };
  const saveEdit = async (id) => {
    const err = validateDraft(draft);
    if (err) {
      setDraftError(err);
      return;
    }
    const next = courses.map((c) => (c.id === id ? { ...c, ...draft } : c));
    await persist(next);
    showToast("Class updated.");
    setEditingId(null);
    setDraftError(null);
    setDraft(emptyDraft);
  };
  const deleteCourse = async (id) => {
    const next = courses.filter((c) => c.id !== id);
    await persist(next);
    showToast("Class deleted.");
    if (editingId === id) cancelEdit();
  };

  const beginAdd = (day) => {
    setEditingId(null);
    setAddingDay(day);
    setDraftError(null);
    setDraft({ ...emptyDraft, day });
  };
  const cancelAdd = () => {
    setAddingDay(null);
    setDraftError(null);
    setDraft(emptyDraft);
  };
  const saveAdd = async () => {
    const err = validateDraft(draft);
    if (err) {
      setDraftError(err);
      return;
    }
    const next = [...(courses || []), { id: makeId(), ...draft }];
    await persist(next);
    showToast("Class added.");
    setAddingDay(null);
    setDraftError(null);
    setDraft(emptyDraft);
  };

  const onDraftKeyDown = (e, onSave) => {
    if (e.key === "Escape") {
      e.preventDefault();
      editingId ? cancelEdit() : cancelAdd();
    } else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      onSave();
    }
  };

  // ---- pointer-based drag & drop (mouse + touch), whole-card draggable ----
  const pendingRef = useRef(null);
  const scrollFallbackRef = useRef(null);
  const LONG_PRESS_MS = 260;
  const TOUCH_CANCEL_PX = 10;
  const MOUSE_ARM_PX = 6;

  const activateDrag = useCallback((course, x, y) => {
    if (pendingRef.current?.timer) clearTimeout(pendingRef.current.timer);
    pendingRef.current = null;
    draggingIdRef.current = course.id;
    setDraggingId(course.id);
    setGhost({ x, y, label: course.course, time: course.start && course.end ? `${course.start}–${course.end}` : "" });
    try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
  }, []);

  const handleRowPointerDown = (e, course) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest && e.target.closest("button, input, select, a, textarea")) return;
    e.preventDefault();
    const isTouch = e.pointerType !== "mouse";
    pendingRef.current = {
      id: course.id,
      course,
      x: e.clientX,
      y: e.clientY,
      timer: isTouch ? setTimeout(() => activateDrag(course, e.clientX, e.clientY), LONG_PRESS_MS) : null,
    };
  };

  const handleWindowPointerMove = useCallback((e) => {
    if (draggingIdRef.current) {
      e.preventDefault();
      setGhost((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g));
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const dayEl = el && el.closest ? el.closest("[data-day]") : null;
      const day = dayEl ? dayEl.getAttribute("data-day") : null;
      if (dragOverDayRef.current !== day) {
        dragOverDayRef.current = day;
        setDragOverDay(day);
      }
      return;
    }
    if (scrollFallbackRef.current) {
      e.preventDefault();
      const deltaY = scrollFallbackRef.current.lastY - e.clientY;
      window.scrollBy(0, deltaY);
      scrollFallbackRef.current.lastY = e.clientY;
      return;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.timer) {
      if (dist > TOUCH_CANCEL_PX) {
        clearTimeout(pending.timer);
        pendingRef.current = null;
        scrollFallbackRef.current = { lastY: e.clientY };
      }
    } else if (dist > MOUSE_ARM_PX) {
      activateDrag(pending.course, e.clientX, e.clientY);
    }
  }, [activateDrag]);

  const finishDrag = useCallback(async () => {
    const id = draggingIdRef.current;
    const day = dragOverDayRef.current;
    draggingIdRef.current = null;
    dragOverDayRef.current = null;
    setDraggingId(null);
    setDragOverDay(null);
    setGhost(null);
    if (!id || !day) return;
    setCourses((prevCourses) => {
      const current = prevCourses.find((c) => c.id === id);
      if (!current || current.day === day) return prevCourses;
      const next = prevCourses.map((c) => (c.id === id ? { ...c, day } : c));
      storage.set(STORAGE_KEY, JSON.stringify(next)).catch(() =>
        showToast("Move saved in this tab, but couldn't write to storage.", "error")
      );
      showToast(`Moved to ${DAY_FULL[day]}.`);
      return next;
    });
  }, [showToast]);

  const handleWindowPointerUp = useCallback(() => {
    scrollFallbackRef.current = null;
    if (pendingRef.current) {
      if (pendingRef.current.timer) clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
      return;
    }
    if (draggingIdRef.current) finishDrag();
  }, [finishDrag]);

  const handleWindowPointerCancel = useCallback(() => {
    if (pendingRef.current?.timer) clearTimeout(pendingRef.current.timer);
    pendingRef.current = null;
    scrollFallbackRef.current = null;
    draggingIdRef.current = null;
    dragOverDayRef.current = null;
    setDraggingId(null);
    setDragOverDay(null);
    setGhost(null);
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [handleWindowPointerMove, handleWindowPointerUp, handleWindowPointerCancel]);

  // ---- derived data ----
  const orderedDays = ALL_DAYS.filter(
    (d) => WEEKDAYS.includes(d) || (courses || []).some((c) => c.day === d)
  );

  const dayGroups = orderedDays.map((d) => {
    const list = (courses || [])
      .filter((c) => c.day === d)
      .map((c) => ({ ...c, _min: parseTimeToMinutes(c.start) }))
      .sort((a, b) => {
        if (a._min == null && b._min == null) return 0;
        if (a._min == null) return 1;
        if (b._min == null) return -1;
        return a._min - b._min;
      });
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const prevEnd = parseTimeToMinutes(prev.end);
      if (prevEnd != null && cur._min != null && cur._min < prevEnd) {
        cur._conflict = true;
        prev._conflict = true;
      }
    }
    return { day: d, list };
  });

  const totalCount = (courses || []).length;
  const fieldStyle = {
    width: "100%", fontSize: 13, padding: "7px 8px", border: `1px solid ${RULE}`,
    borderRadius: 4, marginBottom: 6, fontFamily: "inherit", background: "#fff", color: INK,
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: INK, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; }
        html { -webkit-text-size-adjust: 100%; }
        button, input, select { font-family: inherit; }
        button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
          outline: 2px solid ${INK}; outline-offset: 2px;
        }
        .btn {
          border: 1px solid ${INK}; background: ${INK}; color: #fff; font-weight: 600;
          padding: 9px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          min-height: 38px;
        }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-outline { background: #fff; color: ${INK}; }
        .icon-btn {
          border: none; background: transparent; cursor: pointer; color: ${GRAY};
          padding: 6px; display: inline-flex; align-items: center; border-radius: 4px;
          min-width: 30px; min-height: 30px; justify-content: center;
        }
        .icon-btn:hover { color: ${INK}; background: ${LIGHT_GRAY}; }
        .grip {
          padding: 6px 4px; display: inline-flex; color: ${RULE}; flex-shrink: 0;
        }
        .row.draggable {
          cursor: grab; border-radius: 5px;
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
          touch-action: none;
        }
        .row.draggable:hover { background: ${HILITE}; }
        .row.dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }
        .dropzone {
          border: 1.5px dashed ${GRAY}; border-radius: 8px; padding: 22px 12px; text-align: center; cursor: pointer;
        }
        .dropzone:hover, .dropzone:focus-visible { border-color: ${INK}; background: ${HILITE}; }
        .day-col { border-radius: 8px; transition: background 0.12s ease, border-color 0.12s ease; }
        .row { transition: opacity 0.12s ease; }
        .row.dragging { opacity: 0.3; }
        .conflict-tag {
          display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 700;
          color: ${DANGER}; background: ${DANGER_BG}; border-radius: 3px; padding: 1px 5px; margin-top: 3px;
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
        @media (max-width: 480px) {
          .day-row-time { display: none; }
        }
      `}</style>

      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px 64px" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <CalendarDays size={20} aria-hidden="true" />
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>Weekly Schedule</h1>
        </header>
        <p style={{ fontSize: 12.5, color: GRAY, margin: "4px 0 20px" }}>
          Upload a schedule photo, drag classes between days, or edit any detail directly.
        </p>

        <section aria-label="Upload schedule image" style={{ marginBottom: 22 }}>
          <div
            className="dropzone"
            role="button"
            tabIndex={uploadCount >= MAX_UPLOADS ? -1 : 0}
            aria-label={uploadCount >= MAX_UPLOADS ? "Upload limit reached" : "Upload a schedule photo"}
            aria-disabled={uploadCount >= MAX_UPLOADS}
            onClick={() => uploadCount < MAX_UPLOADS && fileInputRef.current?.click()}
            onKeyDown={(e) => uploadCount < MAX_UPLOADS && (e.key === "Enter" || e.key === " ") && fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={uploadCount < MAX_UPLOADS ? onDropZoneDrop : (e) => e.preventDefault()}
            style={uploadCount >= MAX_UPLOADS ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            {uploadCount >= MAX_UPLOADS ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <AlertCircle size={18} color={GRAY} aria-hidden="true" />
                <span style={{ fontSize: 12.5, color: GRAY }}>Upload limit reached ({MAX_UPLOADS}/{MAX_UPLOADS})</span>
                <span style={{ fontSize: 10.5, color: "#999" }}>You can still edit and rearrange your existing schedule.</span>
              </div>
            ) : imageProcessing ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                <span style={{ fontSize: 12, color: GRAY }}>Processing image…</span>
              </div>
            ) : imageData ? (
              <img src={imageData.previewUrl} alt="Schedule preview, ready to extract" style={{ maxWidth: "100%", maxHeight: 130, borderRadius: 4 }} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <Upload size={18} color={GRAY} aria-hidden="true" />
                <span style={{ fontSize: 12.5, color: GRAY }}>Tap to upload, or drop an image</span>
                <span style={{ fontSize: 10.5, color: "#999" }}>JPG, PNG — up to 15MB</span>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" onChange={onInputChange} style={{ display: "none" }} aria-hidden="true" disabled={uploadCount >= MAX_UPLOADS} />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <span style={{ fontSize: 11, color: "#999" }}>
              {Math.max(MAX_UPLOADS - uploadCount, 0)} of {MAX_UPLOADS} uploads remaining
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn" style={{ flex: 1 }} disabled={!imageData || loading || imageProcessing || uploadCount >= MAX_UPLOADS} onClick={runExtraction}>
              {loading ? (<><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />Reading schedule…</>) : "Extract schedule"}
            </button>
            {imageData && !loading && (
              <button className="btn btn-outline" onClick={() => { setImageData(null); setError(null); }} aria-label="Discard uploaded image">
                <X size={14} />
              </button>
            )}
          </div>

          {error && (
            <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 5, padding: "9px 11px", display: "flex", gap: 7 }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {restoring ? (
          <div style={{ textAlign: "center", color: GRAY, fontSize: 12.5, padding: "30px 0" }}>
            <Loader2 size={16} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} />
            <div>Loading your schedule…</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11.5, color: GRAY }}>
                {totalCount === 0 ? "No classes yet" : `${totalCount} class${totalCount === 1 ? "" : "es"}`}
              </span>
              {totalCount > 0 && (
                <button className="icon-btn" onClick={clearAll} aria-label="Clear entire schedule" title="Clear all">
                  <RotateCcw size={13} />
                </button>
              )}
            </div>

            <div ref={scheduleRef} style={{ background: "#fff", padding: "12px 2px" }}>
              {dayGroups.map(({ day, list }) => {
                const isOver = dragOverDay === day;
                return (
                  <div
                    key={day}
                    className="day-col"
                    data-day={day}
                    style={{
                      marginBottom: 14, padding: "6px 6px 4px",
                      background: isOver ? HILITE : "transparent",
                      border: isOver ? `1.5px dashed ${INK}` : "1.5px dashed transparent",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1.5px solid ${INK}`, paddingBottom: 4, marginBottom: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{DAY_FULL[day]}</span>
                      <button className="icon-btn" title={`Add class on ${DAY_FULL[day]}`} aria-label={`Add class on ${DAY_FULL[day]}`} onClick={() => beginAdd(day)}>
                        <Plus size={14} />
                      </button>
                    </div>

                    {list.length === 0 && addingDay !== day && (
                      <div style={{ fontSize: 11.5, color: "#999", padding: "4px 0 8px" }}>No classes</div>
                    )}

                    {list.map((c, i) => {
                      const isEditing = editingId === c.id;
                      return (
                        <div
                          key={c.id}
                          className={`row${draggingId === c.id ? " dragging" : ""}${!isEditing ? " draggable" : ""}`}
                          onPointerDown={!isEditing ? (e) => handleRowPointerDown(e, c) : undefined}
                          style={{
                            display: "flex", gap: 4, padding: "6px 4px",
                            borderBottom: i < list.length - 1 || isEditing ? `1px solid ${RULE}` : "none",
                            fontSize: 12.5, alignItems: isEditing ? "flex-start" : "center",
                          }}
                        >
                          {!isEditing && (
                            <span className="grip" aria-hidden="true">
                              <GripVertical size={14} />
                            </span>
                          )}

                          {isEditing ? (
                            <div style={{ flex: 1 }} onKeyDown={(e) => onDraftKeyDown(e, () => saveEdit(c.id))}>
                              <input style={fieldStyle} placeholder="Course name" aria-label="Course name" autoFocus value={draft.course} onChange={(e) => setDraft({ ...draft, course: e.target.value })} />
                              <div style={{ display: "flex", gap: 6 }}>
                                <input style={fieldStyle} placeholder="Start (9:00 AM)" aria-label="Start time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
                                <input style={fieldStyle} placeholder="End (10:30 AM)" aria-label="End time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input style={fieldStyle} placeholder="Room" aria-label="Room" value={draft.room} onChange={(e) => setDraft({ ...draft, room: e.target.value })} />
                                <input style={fieldStyle} placeholder="Instructor" aria-label="Instructor" value={draft.instructor} onChange={(e) => setDraft({ ...draft, instructor: e.target.value })} />
                              </div>
                              <select style={fieldStyle} aria-label="Day of week" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })}>
                                {ALL_DAYS.map((d) => (<option key={d} value={d}>{DAY_FULL[d]}</option>))}
                              </select>
                              {draftError && (
                                <div role="alert" style={{ color: DANGER, fontSize: 11.5, marginBottom: 6, display: "flex", gap: 4, alignItems: "flex-start" }}>
                                  <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} /> {draftError}
                                </div>
                              )}
                              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                                <button className="btn" style={{ padding: "5px 12px", fontSize: 12, minHeight: 30 }} onClick={() => saveEdit(c.id)}><Check size={12} /> Save</button>
                                <button className="btn btn-outline" style={{ padding: "5px 12px", fontSize: 12, minHeight: 30 }} onClick={cancelEdit}><X size={12} /> Cancel</button>
                                <button className="icon-btn" style={{ marginLeft: "auto" }} aria-label={`Delete ${c.course}`} onClick={() => deleteCourse(c.id)}><Trash2 size={13} /></button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600 }}>{c.course}</div>
                                {(c.room || c.instructor) && (
                                  <div style={{ color: GRAY, fontSize: 11 }}>{[c.room, c.instructor].filter(Boolean).join(" · ")}</div>
                                )}
                                {c._conflict && (
                                  <div className="conflict-tag"><AlertTriangle size={10} /> Time conflict</div>
                                )}
                              </div>
                              {(c.start || c.end) && (
                                <div className="day-row-time" style={{ color: GRAY, fontSize: 11, whiteSpace: "nowrap", flexShrink: 0, marginTop: 1 }}>
                                  {c.start}{c.end ? `–${c.end}` : ""}
                                </div>
                              )}
                              <button className="icon-btn" aria-label={`Edit ${c.course}`} onClick={() => startEdit(c)}>
                                <Pencil size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}

                    {addingDay === day && (
                      <div style={{ padding: "6px 0", borderTop: list.length ? `1px solid ${RULE}` : "none" }} onKeyDown={(e) => onDraftKeyDown(e, saveAdd)}>
                        <input style={fieldStyle} placeholder="Course name" aria-label="Course name" autoFocus value={draft.course} onChange={(e) => setDraft({ ...draft, course: e.target.value })} />
                        <div style={{ display: "flex", gap: 6 }}>
                          <input style={fieldStyle} placeholder="Start (9:00 AM)" aria-label="Start time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
                          <input style={fieldStyle} placeholder="End (10:30 AM)" aria-label="End time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input style={fieldStyle} placeholder="Room" aria-label="Room" value={draft.room} onChange={(e) => setDraft({ ...draft, room: e.target.value })} />
                          <input style={fieldStyle} placeholder="Instructor" aria-label="Instructor" value={draft.instructor} onChange={(e) => setDraft({ ...draft, instructor: e.target.value })} />
                        </div>
                        {draftError && (
                          <div role="alert" style={{ color: DANGER, fontSize: 11.5, marginBottom: 6, display: "flex", gap: 4, alignItems: "flex-start" }}>
                            <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} /> {draftError}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                          <button className="btn" style={{ padding: "5px 12px", fontSize: 12, minHeight: 30 }} onClick={saveAdd}><Check size={12} /> Add</button>
                          <button className="btn btn-outline" style={{ padding: "5px 12px", fontSize: 12, minHeight: 30 }} onClick={cancelAdd}><X size={12} /> Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {totalCount === 0 && !restoring && (
              <div style={{ textAlign: "center", color: GRAY, fontSize: 12.5, padding: "24px 0", borderTop: `1px solid ${RULE}` }}>
                Upload a photo above, or tap the <Plus size={11} style={{ verticalAlign: "-1px" }} /> next to any day to add a class manually.
              </div>
            )}

            {totalCount > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-outline" style={{ flex: 1 }} disabled={!exportReady || exporting} onClick={() => downloadImage("png")}>
                  {exporting ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />} PNG
                </button>
                <button className="btn btn-outline" style={{ flex: 1 }} disabled={!exportReady || exporting} onClick={() => downloadImage("jpg")}>
                  {exporting ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />} JPG
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {ghost && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed", left: ghost.x + 12, top: ghost.y + 12, zIndex: 9999,
            pointerEvents: "none", background: INK, color: "#fff", borderRadius: 6,
            padding: "6px 10px", fontSize: 11.5, boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            maxWidth: 200,
          }}
        >
          <div style={{ fontWeight: 700 }}>{ghost.label}</div>
          {ghost.time && <div style={{ opacity: 0.8, fontSize: 10.5 }}>{ghost.time}</div>}
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          key={toast.key}
          style={{
            position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)",
            background: toast.kind === "error" ? DANGER : INK, color: "#fff",
            padding: "9px 16px", borderRadius: 20, fontSize: 12.5, display: "flex",
            alignItems: "center", gap: 6, boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
            animation: "toastIn 0.15s ease-out", zIndex: 9999, maxWidth: "90vw",
          }}
        >
          {toast.kind === "error" ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
