(function () {
  "use strict";

  const KEY = "agapay-system-v2";
  const LEGACY_KEY = "agapay-demo-v1";
  const initialState = {
    version: 2,
    currentUser: null,
    settings: { orgName: "Agapay Samaritans", currency: "PHP", notifications: true },
    donors: [],
    donations: [],
    receipts: [],
    users: [],
    audit: [],
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  async function passwordDigest(password, salt) {
    if (!window.crypto?.subtle)
      throw new Error(
        "Secure password hashing is unavailable in this browser. Open the prototype in a current browser."
      );
    const material = await window.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await window.crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 120000, hash: "SHA-256" },
      material,
      256
    );
    return [...new Uint8Array(bits)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  async function legacyPasswordDigest(password, salt) {
    const bytes = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  function newSalt() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  function load() {
    try {
      const saved = localStorage.getItem(KEY);
      if (!saved) {
        return clone(initialState);
      }
      const state = JSON.parse(saved);
      if (
        !state ||
        state.version !== 2 ||
        !Array.isArray(state.users) ||
        !Array.isArray(state.donations) ||
        !Array.isArray(state.donors)
      ) {
        throw new Error(
          "Saved system data is invalid. Clear this site's browser storage to start again."
        );
      }
      return state;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(
          "Saved system data could not be read. Clear this site's browser storage to start again."
        );
      throw error;
    }
  }
  let state = clone(initialState);
  let saveQueue = Promise.resolve();
  const store = {
    get state() {
      return state;
    },
    save() {
      const snapshot = clone(state);
      saveQueue = saveQueue.catch(() => {}).then(async () => {
        const response = await fetch("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: snapshot }),
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `Database save failed (${response.status}).`);
        }
      });
      saveQueue.catch((error) =>
        showToast(error.message || "Could not save data to PostgreSQL.", true)
      );
      return saveQueue;
    },
    reset() {
      state.donors = [];
      state.donations = [];
      state.receipts = [];
      store.save();
    },
    nextId(items, prefix) {
      const max = items.reduce(
        (largest, item) =>
          Math.max(largest, Number(String(item.id || "").match(/(\d+)$/)?.[1] || 0)),
        1000
      );
      return `${prefix}-${String(max + 1).padStart(4, "0")}`;
    },
    audit(action, entity, detail) {
      state.audit.unshift({
        id: `LOG-${Date.now()}`,
        at: new Date().toISOString(),
        actor: state.currentUser?.email || state.currentUser?.name || "Signed out",
        action,
        entity,
        detail,
      });
      state.audit = state.audit.slice(0, 500);
      store.save();
    },
    donorName(id) {
      return state.donors.find((donor) => donor.id === id)?.name || "Unknown donor";
    },
  };

  const roles = {
    Administrator: [
      "dashboard",
      "donors",
      "donations",
      "verification",
      "receipts",
      "reports",
      "users",
      "audit",
      "settings",
    ],
    "Donation Staff": ["dashboard", "donors", "donations", "receipts"],
    "Finance Officer": ["dashboard", "donations", "verification", "receipts", "reports"],
    Management: ["dashboard", "reports"],
  };
  const actionRoles = {
    "new-donor": ["Administrator", "Donation Staff"],
    "edit-donor": ["Administrator", "Donation Staff"],
    "delete-donor": ["Administrator", "Donation Staff"],
    "new-donation": ["Administrator", "Donation Staff"],
    "edit-donation": ["Administrator", "Donation Staff"],
    "cancel-donation": ["Administrator", "Donation Staff"],
    "delete-donation": ["Administrator", "Donation Staff"],
    "verify-donation": ["Administrator", "Finance Officer"],
    "reject-donation": ["Administrator", "Finance Officer"],
    "issue-receipt": ["Administrator", "Donation Staff", "Finance Officer"],
    "view-receipt": ["Administrator", "Donation Staff", "Finance Officer"],
    "send-receipt": ["Administrator", "Donation Staff", "Finance Officer"],
    "export-report": ["Administrator", "Finance Officer", "Management"],
    "export-audit": ["Administrator"],
    "new-user": ["Administrator"],
    "edit-user": ["Administrator"],
    "toggle-user": ["Administrator"],
    "settings-form": ["Administrator"],
    "clear-records": ["Administrator"],
  };
  const canAccess = (page) =>
    Boolean(state.currentUser && roles[state.currentUser.role]?.includes(page));
  const canPerform = (action) =>
    !actionRoles[action] || actionRoles[action].includes(state.currentUser?.role);

  const calc = {
    dollars(amount) {
      return Math.round((Number(amount) + Number.EPSILON) * 100);
    },
    percent(numerator, denominator) {
      return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
    },
    ageDays(date, now = new Date()) {
      const start = new Date(`${date}T00:00:00`);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (Number.isNaN(start.getTime())) return 0;
      return Math.max(0, Math.floor((end - start) / 86400000));
    },
    verified() {
      return state.donations.filter((donation) => donation.status === "verified");
    },
    metrics() {
      const allVerified = calc.verified();
      const eligible = allVerified.filter((donation) => donation.eligible !== false);
      const receiptByDonation = new Map(
        state.receipts.map((receipt) => [receipt.donationId, receipt])
      );
      const issued = eligible.filter((donation) => receiptByDonation.has(donation.id));
      const due = eligible.filter(
        (donation) => calc.ageDays(donation.date) >= 15 || receiptByDonation.has(donation.id)
      );
      const timely = due.filter((donation) => {
        const receipt = receiptByDonation.get(donation.id);
        if (!receipt || receipt.issuedAt < donation.date) return false;
        const elapsedDays = calc.ageDays(donation.date) - calc.ageDays(receipt.issuedAt);
        return elapsedDays >= 0 && elapsedDays <= 15;
      });
      const totalCents = allVerified.reduce((sum, donation) => sum + donation.amountCents, 0);
      return {
        totalCents,
        verifiedCount: allVerified.length,
        pendingCount: state.donations.filter((donation) => donation.status === "pending").length,
        pendingCents: state.donations
          .filter((donation) => donation.status === "pending")
          .reduce((sum, donation) => sum + donation.amountCents, 0),
        donorCount: state.donors.length,
        receiptCount: state.receipts.length,
        eligibleCount: eligible.length,
        unissuedCount: eligible.length - issued.length,
        receiptRate: calc.percent(issued.length, eligible.length),
        complianceRate: calc.percent(timely.length, due.length),
        overdueCount: due.filter((donation) => !receiptByDonation.has(donation.id)).length,
        averageCents: allVerified.length ? Math.round(totalCents / allVerified.length) : 0,
      };
    },
    programs() {
      const totals = new Map();
      calc
        .verified()
        .forEach((donation) =>
          totals.set(donation.program, (totals.get(donation.program) || 0) + donation.amountCents)
        );
      const total = calc.metrics().totalCents;
      return [...totals.entries()]
        .map(([name, totalCents]) => ({ name, totalCents, share: calc.percent(totalCents, total) }))
        .sort((a, b) => b.totalCents - a.totalCents);
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = (element, value) => {
    if (element) element.textContent = value == null ? "" : String(value);
  };
  const currency = (cents) =>
    new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      minimumFractionDigits: 2,
    }).format((Number(cents) || 0) / 100);
  const formatDate = (value) => {
    if (!value) return "—";
    const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
  };
  const todayString = () => new Date().toISOString().slice(0, 10);
  let currentPage = location.hash.slice(1) || "login";
  const donorFor = (id) => state.donors.find((donor) => donor.id === id);
  function rowFrom(templateId, bodyId, emptyMessage) {
    const template = $(`#${templateId}`);
    const row = template.content.firstElementChild.cloneNode(true);
    const body = $(`#${bodyId}`);
    body.append(row);
    return row;
  }
  function setField(row, key, value) {
    const field = $(`[data-field="${key}"]`, row);
    text(field, value);
    return field;
  }
  function setBadge(field, value) {
    if (!field) return;
    text(field, value);
    field.className = `badge badge-${String(value).toLowerCase().replaceAll(" ", "-")}`;
  }
  function setRowSearch(row, values, fields = {}) {
    row.dataset.searchable = values.join(" ").toLowerCase();
    Object.entries(fields).forEach(([key, value]) => {
      row.dataset[key] = value;
    });
  }
  function clearBody(bodyId) {
    const body = $(`#${bodyId}`);
    body.replaceChildren();
    return body;
  }
  function populateSelect(select, items, selected, label) {
    const template = $("#option-template");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = label;
    select.replaceChildren(placeholder);
    items.forEach((item) => {
      const option = template.content.firstElementChild.cloneNode(true);
      option.value = item.id;
      option.textContent = `${item.name} — ${item.id}`;
      option.selected = item.id === selected;
      select.append(option);
    });
  }
  function populateMetrics() {
    const metric = calc.metrics();
    const values = {
      total: currency(metric.totalCents),
      "verified-count": metric.verifiedCount,
      "pending-count": metric.pendingCount,
      "pending-total": currency(metric.pendingCents),
      "receipt-rate": `${metric.receiptRate}%`,
      "compliance-rate": `${metric.complianceRate}%`,
      "receipt-count": metric.receiptCount,
      "eligible-count": metric.eligibleCount,
      "overdue-count": metric.overdueCount,
      "unissued-count": metric.unissuedCount,
      "donation-count": state.donations.length,
      "donor-count": state.donors.length,
    };
    $$("[data-metric]").forEach((element) => text(element, values[element.dataset.metric]));
    $$("[data-progress='compliance']").forEach((element) => {
      element.style.width = `${metric.complianceRate}%`;
    });
    $$("[data-count]").forEach((element) => {
      const counts = {
        donors: `${state.donors.length} donors`,
        donations: `${state.donations.length} records`,
        users: `${state.users.length} user profiles`,
        audit: `${state.audit.length} entries`,
        "pending-queue": `${metric.pendingCount} awaiting review`,
        unissued: `${metric.unissuedCount} eligible verified donation${
          metric.unissuedCount === 1 ? "" : "s"
        } without a receipt`,
      };
      text(element, counts[element.dataset.count]);
    });
    text(
      $("[data-today]"),
      new Date().toLocaleDateString("en", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    );
    text($("[data-dashboard-first-name]"), (state.currentUser?.name || "there").split(" ")[0]);
    text($("#user-name"), state.currentUser?.name || "Signed out");
    text($("#user-role"), state.currentUser?.role || "");
    text(
      $("#user-avatar"),
      (state.currentUser?.name || "?")
        .split(/\s+/)
        .map((part) => part[0] || "")
        .slice(0, 2)
        .join("")
        .toUpperCase()
    );
    text(
      $("#current-section"),
      $("#" + currentPage)?.querySelector("h1")?.textContent || "Overview"
    );
    const settingsName = $("#org-name");
    if (settingsName && document.activeElement !== settingsName)
      settingsName.value = state.settings.orgName;
  }
  function populateDonors() {
    const body = clearBody(
      "donor-rows",
      "empty-row-template",
      state.donors.length ? "" : "No donor records found.",
      7
    );
    state.donors.forEach((donor) => {
      const row = rowFrom("donor-row-template", "donor-rows");
      const gifts = state.donations.filter((item) => item.donorId === donor.id);
      const verifiedCents = gifts
        .filter((item) => item.status === "verified")
        .reduce((sum, item) => sum + item.amountCents, 0);
      setField(row, "name", donor.name);
      setField(row, "id", donor.id);
      setField(row, "email", donor.email);
      setField(row, "phone", donor.phone || "—");
      setField(row, "type", donor.type);
      setField(row, "gift-count", `${gifts.length} gift${gifts.length === 1 ? "" : "s"}`);
      setField(row, "verified-giving", currency(verifiedCents));
      $$("[data-action]", row).forEach((button) => {
        button.dataset.id = donor.id;
      });
      setRowSearch(row, [donor.name, donor.email, donor.id, donor.type], { type: donor.type });
    });
    if (!state.donors.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateDonations() {
    const sorted = [...state.donations].sort((a, b) => b.date.localeCompare(a.date));
    const body = clearBody(
      "donation-rows",
      "empty-row-template",
      sorted.length ? "" : "No donations yet. Record a donation to get started.",
      7
    );
    sorted.forEach((donation) => {
      const row = rowFrom("donation-row-template", "donation-rows");
      const donor = donorFor(donation.donorId);
      setField(row, "id", donation.id);
      setField(row, "date", formatDate(donation.date));
      setField(row, "donor", donor?.name || "Unknown donor");
      setField(row, "amount", currency(donation.amountCents));
      setField(row, "program", donation.program);
      setField(row, "channel", donation.channel);
      setField(row, "reference", donation.reference);
      setBadge($("[data-field='status']", row), donation.status);
      text(
        $("[data-field='age']", row),
        donation.status === "pending" ? `${calc.ageDays(donation.date)} days pending` : ""
      );
      $$("[data-action]", row).forEach((button) => {
        button.dataset.id = donation.id;
      });
      $("[data-action='cancel-donation']", row).hidden = donation.status !== "pending";
      $("[data-action='edit-donation']", row).hidden = donation.status === "verified";
      $("[data-action='delete-donation']", row).hidden =
        donation.status === "verified" ||
        state.receipts.some((receipt) => receipt.donationId === donation.id);
      setRowSearch(
        row,
        [donation.id, donor?.name, donation.reference, donation.program, donation.channel],
        { status: donation.status, program: donation.program, date: donation.date }
      );
    });
    if (!sorted.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateVerification() {
    const pending = state.donations.filter((donation) => donation.status === "pending");
    const body = clearBody(
      "verification-rows",
      "empty-row-template",
      pending.length
        ? ""
        : "The queue is clear. New donations appear here until verified or rejected.",
      6
    );
    const canVerify = canPerform("verify-donation");
    pending.forEach((donation) => {
      const row = rowFrom("verification-row-template", "verification-rows");
      const donor = donorFor(donation.donorId);
      setField(row, "id", donation.id);
      setField(
        row,
        "age",
        `${formatDate(donation.date)} · ${calc.ageDays(donation.date)} days old`
      );
      setField(row, "donor", donor?.name || "Unknown donor");
      setField(row, "email", donor?.email || "");
      setField(row, "amount", currency(donation.amountCents));
      setField(row, "channel", donation.channel);
      setField(row, "reference", `Ref: ${donation.reference}`);
      setField(row, "evidence", donation.evidence || "No evidence note");
      const duplicate = state.donations.some(
        (item) =>
          item.id !== donation.id &&
          item.reference.toLowerCase() === donation.reference.toLowerCase()
      );
      text($(".duplicate-warning", row), duplicate ? "Possible duplicate reference" : "");
      if (duplicate) $(".duplicate-warning", row).classList.add("warning-text");
      $$("[data-action]", row).forEach((button) => {
        button.dataset.id = donation.id;
        button.disabled = !canPerform(button.dataset.action);
      });
      setRowSearch(row, [donation.id, donor?.name, donation.reference, donation.channel]);
    });
    if (!pending.length) body.append($("#empty-row-template").content.cloneNode(true));
    const note = $("#verification .page-notice");
    note.dataset.roleNote = canVerify ? "" : " Payment decisions are restricted by role.";
    note.lastChild.textContent = ` Payment status is managed locally and is not confirmed with a bank or payment provider. Review evidence and duplicate references before marking a contribution verified.${note.dataset.roleNote}`;
  }
  function populatePrograms(bodyId) {
    const groups = calc.programs();
    const body = clearBody(
      bodyId,
      "empty-row-template",
      groups.length ? "" : "No verified donations to summarize.",
      3
    );
    groups.forEach((program) => {
      const row = rowFrom("program-row-template", bodyId);
      setField(row, "program", program.name);
      setField(row, "amount", currency(program.totalCents));
      setField(row, "share", `${program.share}%`);
    });
    if (!groups.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateReceipts() {
    const receipts = new Map(state.receipts.map((receipt) => [receipt.donationId, receipt]));
    const eligible = state.donations.filter(
      (donation) => donation.status === "verified" && donation.eligible !== false
    );
    const unissued = eligible.filter((donation) => !receipts.has(donation.id));
    const pendingBody = clearBody(
      "unissued-rows",
      "empty-row-template",
      unissued.length ? "" : "All eligible verified donations have an acknowledgment receipt.",
      6
    );
    unissued.forEach((donation) => {
      const row = rowFrom("receipt-pending-template", "unissued-rows");
      setField(row, "id", donation.id);
      setField(row, "date", formatDate(donation.date));
      setField(row, "donor", store.donorName(donation.donorId));
      setField(row, "amount", currency(donation.amountCents));
      setField(row, "program", donation.program);
      setField(row, "age", `${calc.ageDays(donation.date)} days`);
      $("[data-action]", row).dataset.id = donation.id;
      setRowSearch(row, [donation.id, store.donorName(donation.donorId), donation.program]);
    });
    if (!unissued.length) pendingBody.append($("#empty-row-template").content.cloneNode(true));
    const issued = [...state.receipts].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    const issuedBody = clearBody(
      "receipt-rows",
      "empty-row-template",
      issued.length ? "" : "No receipts issued yet.",
      6
    );
    issued.forEach((receipt) => {
      const donation = state.donations.find((item) => item.id === receipt.donationId);
      if (!donation || donation.status !== "verified") return;
      const donor = donorFor(donation.donorId);
      const row = rowFrom("receipt-row-template", "receipt-rows");
      setField(row, "id", receipt.id);
      setField(row, "donation", `Donation ${donation.id}`);
      setField(row, "donor", donor?.name || "Unknown donor");
      setField(row, "email", donor?.email || "");
      setField(row, "amount", currency(donation.amountCents));
      setField(row, "date", formatDate(receipt.issuedAt));
      const delivery = $("[data-field='delivery']", row);
      setBadge(delivery, receipt.delivery === "not-sent" ? "pending" : receipt.delivery);
      text(delivery, receipt.delivery === "not-sent" ? "not sent" : receipt.delivery);
      text(
        $("[data-field='delivered-date']", row),
        receipt.deliveredAt ? formatDate(receipt.deliveredAt) : ""
      );
      $$("[data-action]", row).forEach((button) => {
        button.dataset.id = receipt.id;
      });
      $("[data-action='send-receipt']", row).hidden = receipt.delivery === "sent";
      setRowSearch(row, [receipt.id, donation.id, donor?.name, receipt.delivery]);
    });
    if (
      !issued.some((receipt) =>
        state.donations.some((item) => item.id === receipt.donationId && item.status === "verified")
      )
    )
      issuedBody.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateUsers() {
    const body = clearBody(
      "user-rows",
      "empty-row-template",
      state.users.length ? "" : "No user profiles found.",
      5
    );
    state.users.forEach((user) => {
      const row = rowFrom("user-row-template", "user-rows");
      setField(row, "name", user.name);
      setField(row, "id", user.id);
      setField(row, "email", user.email);
      setField(row, "role", user.role);
      setBadge($("[data-field='status']", row), user.status === "Active" ? "verified" : "neutral");
      text($("[data-field='status']", row), user.status);
      $$("[data-action]", row).forEach((button) => {
        button.dataset.id = user.id;
      });
      text(
        $("[data-action='toggle-user']", row),
        user.status === "Active" ? "Deactivate" : "Activate"
      );
      $("[data-action='toggle-user']", row).disabled = user.id === state.currentUser?.id;
      setRowSearch(row, [user.name, user.email, user.role]);
    });
    if (!state.users.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateAudit() {
    const body = clearBody(
      "audit-rows",
      "empty-row-template",
      state.audit.length ? "" : "No audit events have been recorded.",
      5
    );
    state.audit.forEach((entry) => {
      const row = rowFrom("audit-row-template", "audit-rows");
      text(
        $("[data-field='date']", row),
        new Date(entry.at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
      );
      setField(row, "actor", entry.actor);
      setField(row, "action", entry.action);
      setField(row, "entity", entry.entity);
      setField(row, "detail", entry.detail);
      setRowSearch(row, [entry.actor, entry.action, entry.entity, entry.detail]);
    });
    if (!state.audit.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateRecent() {
    const recent = [...state.donations].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const body = clearBody(
      "dashboard-recent",
      "empty-row-template",
      recent.length ? "" : "No donations recorded yet.",
      6
    );
    const receiptIds = new Set(state.receipts.map((receipt) => receipt.donationId));
    recent.forEach((donation) => {
      const row = rowFrom("recent-row-template", "dashboard-recent");
      setField(row, "id", donation.id);
      setField(row, "date", formatDate(donation.date));
      setField(row, "donor", store.donorName(donation.donorId));
      setField(row, "program", donation.program);
      setField(row, "amount", currency(donation.amountCents));
      setBadge($("[data-field='status']", row), donation.status);
      const receipt =
        donation.status !== "verified"
          ? "—"
          : receiptIds.has(donation.id)
          ? "receipt issued"
          : "receipt due";
      text($("[data-field='receipt']", row), receipt);
    });
    if (!recent.length) body.append($("#empty-row-template").content.cloneNode(true));
  }
  function populateReports() {
    const body = clearBody(
      "report-donation-rows",
      "empty-row-template",
      state.donations.length ? "" : "No donation records found.",
      7
    );
    state.donations.forEach((donation) => {
      const row = rowFrom("report-donation-row-template", "report-donation-rows");
      setField(row, "id", donation.id);
      setField(row, "donor", store.donorName(donation.donorId));
      setField(row, "date", formatDate(donation.date));
      setField(row, "program", donation.program);
      setField(row, "channel", donation.channel);
      setField(row, "amount", currency(donation.amountCents));
      setBadge($("[data-field='status']", row), donation.status);
      setRowSearch(
        row,
        [donation.id, store.donorName(donation.donorId), donation.program, donation.reference],
        { status: donation.status, program: donation.program, date: donation.date }
      );
    });
    if (!state.donations.length) body.append($("#empty-row-template").content.cloneNode(true));
    populatePrograms("report-programs");
  }
  function populateDonorOptions(selected = "") {
    populateSelect($("#donation-donor"), state.donors, selected, "Choose donor");
  }
  function populateCharts() {
    const monthly = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setMonth(date.getMonth() - (5 - index), 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const cents = state.donations
        .filter((item) => item.status === "verified" && item.date.startsWith(key))
        .reduce((sum, item) => sum + item.amountCents, 0);
      return { label: date.toLocaleString("en", { month: "short" }), cents };
    });
    const max = Math.max(1, ...monthly.map((month) => month.cents));
    $$("[data-chart]").forEach((chart) => {
      monthly.forEach((month, index) => {
        const column = $(`[data-month="${index}"]`, chart);
        const bar = $(".chart-bar", column);
        bar.style.height = `${month.cents ? Math.max(3, (month.cents / max) * 100) : 0}%`;
        bar.style.minHeight = month.cents ? "3px" : "0";
        bar.title = currency(month.cents);
        text($(".chart-label", column), month.label);
      });
    });
  }
  function sync() {
    if (!state.currentUser) currentPage = "login";
    else if (!canAccess(currentPage)) currentPage = "dashboard";
    if (location.hash !== `#${currentPage}`) location.hash = `#${currentPage}`;
    populateMetrics();
    populateDonors();
    populateDonations();
    populateVerification();
    populateReceipts();
    populateUsers();
    populateAudit();
    populateRecent();
    populatePrograms("dashboard-programs");
    populateReports();
    populateCharts();
    populateDonorOptions($("#donation-form [name='donorId']")?.value || "");
    $$(".view h1").forEach((heading) => {
      heading
        .closest(".view")
        .setAttribute(
          "aria-hidden",
          heading.closest(".view").id === currentPage ? "false" : "true"
        );
    });
    $$("a[href^='#']").forEach((link) => {
      const page = link.getAttribute("href").slice(1);
      if (page !== "login" && page !== "dashboard") link.hidden = !canAccess(page);
    });
    $$("[data-action]").forEach((button) => {
      if (actionRoles[button.dataset.action]) button.hidden = !canPerform(button.dataset.action);
    });
    $("#workspace").hidden = !state.currentUser;
    $("#login").hidden = Boolean(state.currentUser);
    $("#login").classList.toggle("login-active", !state.currentUser);
    $$(".nav-link[href^='#']").forEach((link) => {
      link.setAttribute(
        "aria-current",
        link.getAttribute("href") === `#${currentPage}` ? "page" : "false"
      );
    });
    document.title = `${
      $("#" + currentPage)?.querySelector("h1")?.textContent || "Welcome"
    } | Agapay Samaritans`;
    applyFilters();
  }
  function applyFilters() {
    const page = $("#" + currentPage);
    if (!page) return;
    const searchInput = $("[data-search-table]", page);
    const search = (searchInput?.value || "").trim().toLowerCase();
    const status = $("[data-filter-status]", page)?.value || "";
    const program = $("[data-filter-program]", page)?.value || "";
    const type = $("[data-filter-type]", page)?.value || "";
    const from = $("[data-date-from]", page)?.value || "";
    const to = $("[data-date-to]", page)?.value || "";
    $$("tbody tr[data-searchable]", page).forEach((row) => {
      row.hidden = !(
        (!search || row.dataset.searchable.includes(search)) &&
        (!status || row.dataset.status === status) &&
        (!program || row.dataset.program === program) &&
        (!type || row.dataset.type === type) &&
        (!from || !row.dataset.date || row.dataset.date >= from) &&
        (!to || !row.dataset.date || row.dataset.date <= to)
      );
    });
    $$("tbody", page).forEach((body) => {
      const rows = $$("tr[data-searchable]", body);
      const empty = $(".filter-empty", body);
      if (rows.length && rows.every((row) => row.hidden)) {
        if (!empty) {
          const cloneRow = $("#empty-row-template").content.firstElementChild.cloneNode(true);
          cloneRow.classList.add("filter-empty");
          $("td", cloneRow).colSpan = body.closest("table").tHead.rows[0].cells.length;
          text($(".empty-state", cloneRow), "No matching records. Adjust your search or filters.");
          body.append(cloneRow);
        }
      } else empty?.remove();
    });
  }
  function refresh() {
    currentPage = location.hash.slice(1) || "login";
    if (!state.currentUser) currentPage = "login";
    else if (!$("#" + currentPage)?.classList.contains("view") || !canAccess(currentPage))
      currentPage = "dashboard";
    if (location.hash !== `#${currentPage}`) location.hash = `#${currentPage}`;
    sync();
  }
  function showToast(message, error = false) {
    const toast = $("#toast-message");
    text(toast, message);
    toast.classList.toggle("error", error);
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3500);
  }
  function openDialog(id, form, title, values = {}) {
    const dialog = $(`#${id}`);
    if (!dialog) return;
    if (form) {
      form.reset();
      const idField = form.elements.namedItem("id");
      if (idField) idField.value = values.id || "";
      Object.entries(values).forEach(([key, value]) => {
        const field = form.elements.namedItem(key);
        if (field && key !== "id") field.value = value;
      });
      if (id === "user-dialog") {
        const password = $("#user-password");
        password.required = !values.id;
        password.value = "";
      }
    }
    text($(`#${id}-title`), title);
    const submit = $("button[type='submit']", dialog);
    if (submit)
      text(
        submit,
        title.startsWith("Edit")
          ? "Save changes"
          : id === "donation-dialog"
          ? "Save as pending"
          : id === "user-dialog"
          ? "Add user"
          : "Create donor"
      );
    if (id === "donation-dialog") {
      populateDonorOptions(values.donorId || "");
      $("#donation-date").max = todayString();
      if (!values.date) $("#donation-date").value = todayString();
    }
    dialog.showModal();
  }
  function closeDialog(button) {
    button.closest("dialog")?.close();
  }
  function formData(form) {
    return Object.fromEntries(new FormData(form));
  }

  function saveDonor(form) {
    const data = formData(form);
    const existing = state.donors.find((item) => item.id === data.id);
    if (existing) {
      Object.assign(existing, {
        name: data.name.trim(),
        email: data.email.trim(),
        phone: data.phone.trim(),
        type: data.type,
      });
      store.audit("Donor updated", existing.id, `Updated donor profile for ${existing.name}.`);
    } else {
      const donor = {
        id: store.nextId(state.donors, "DNR"),
        name: data.name.trim(),
        email: data.email.trim(),
        phone: data.phone.trim(),
        type: data.type,
        createdAt: todayString(),
      };
      state.donors.unshift(donor);
      store.audit("Donor created", donor.id, `Added donor profile for ${donor.name}.`);
    }
    store.save();
    $("#donor-dialog").close();
    sync();
    showToast(existing ? "Donor profile updated." : "Donor added.");
  }
  function saveDonation(form) {
    const data = formData(form);
    const amountCents = calc.dollars(data.amount);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      throw new Error("Enter a valid donation amount greater than zero.");
    const duplicate = state.donations.find(
      (item) =>
        item.reference.toLowerCase() === data.reference.trim().toLowerCase() && item.id !== data.id
    );
    if (
      duplicate &&
      !window.confirm(
        `Reference ${data.reference} is already used by ${duplicate.id} (${duplicate.status}). Save this possible duplicate anyway?`
      )
    )
      return;
    const existing = state.donations.find((item) => item.id === data.id);
    if (existing) {
      if (existing.status === "verified")
        throw new Error("Verified donations cannot be edited from this screen.");
      Object.assign(existing, {
        donorId: data.donorId,
        amountCents,
        date: data.date,
        program: data.program,
        channel: data.channel,
        reference: data.reference.trim(),
        evidence: data.evidence.trim(),
      });
      store.audit("Donation updated", existing.id, `Updated pending donation ${existing.id}.`);
    } else {
      const donation = {
        id: store.nextId(state.donations, "DNT"),
        donorId: data.donorId,
        amountCents,
        date: data.date,
        program: data.program,
        channel: data.channel,
        reference: data.reference.trim(),
        evidence: data.evidence.trim(),
        status: "pending",
        eligible: true,
        verifiedAt: "",
        note: "",
      };
      state.donations.unshift(donation);
      store.audit(
        "Donation recorded",
        donation.id,
        `Recorded ${currency(amountCents)} for ${data.program}; pending payment verification.`
      );
    }
    store.save();
    $("#donation-dialog").close();
    sync();
    showToast(existing ? "Donation updated." : "Donation saved as pending verification.");
  }
  async function saveUser(form) {
    const data = formData(form);
    const existing = state.users.find((item) => item.id === data.id);
    const email = data.email.trim().toLowerCase();
    if (!Object.hasOwn(roles, data.role)) throw new Error("Choose a valid user role.");
    if (state.users.some((item) => item.email.toLowerCase() === email && item.id !== data.id))
      throw new Error("An account already uses this email address.");
    if (!existing && data.password.length < 10)
      throw new Error("New account passwords must be at least 10 characters.");
    if (existing && data.password && data.password.length < 10)
      throw new Error("Passwords must be at least 10 characters.");
    if (existing) {
      if (
        existing.role === "Administrator" &&
        existing.status === "Active" &&
        data.role !== "Administrator" &&
        state.users.filter((item) => item.role === "Administrator" && item.status === "Active")
          .length <= 1
      ) {
        throw new Error("At least one active Administrator account must remain.");
      }
      Object.assign(existing, { name: data.name.trim(), email, role: data.role });
      if (data.password) {
        existing.salt = newSalt();
        existing.passwordHash = await passwordDigest(data.password, existing.salt);
        existing.passwordChangedAt = new Date().toISOString();
      }
      if (state.currentUser?.id === existing.id)
        state.currentUser = {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          role: existing.role,
        };
      store.audit(
        "User profile updated",
        existing.id,
        `Updated ${existing.name}'s profile and role.`
      );
    } else {
      const salt = newSalt();
      const user = {
        id: store.nextId(state.users, "USR"),
        name: data.name.trim(),
        email,
        role: data.role,
        status: "Active",
        salt,
        passwordHash: await passwordDigest(data.password, salt),
      };
      state.users.push(user);
      store.audit("User profile created", user.id, `Added ${user.name} with role ${user.role}.`);
    }
    store.save();
    $("#user-dialog").close();
    sync();
    showToast("User account saved.");
  }
  function saveSettings(form) {
    const data = formData(form);
    state.settings.orgName = data.orgName.trim();
    state.settings.currency = "PHP";
    store.audit(
      "Settings updated",
      "System",
      `Updated organization name to ${data.orgName.trim()}.`
    );
    store.save();
    sync();
    showToast("Organization settings saved.");
  }
  function openDecisionDialog(action, id) {
    if (!["verify-donation", "reject-donation"].includes(action))
      throw new Error("Unsupported payment decision.");
    if (!canPerform(action)) throw new Error("Your role is not permitted to review payments.");
    const donation = state.donations.find((item) => item.id === id);
    if (!donation || donation.status !== "pending")
      throw new Error("This donation is no longer pending review.");
    const isVerification = action === "verify-donation";
    const duplicate = state.donations.filter(
      (item) => item.id !== id && item.reference.toLowerCase() === donation.reference.toLowerCase()
    );
    const form = $("#decision-form");
    form.reset();
    form.elements.namedItem("id").value = id;
    form.elements.namedItem("decision").value = action;
    $("#decision-dialog-title").textContent = isVerification ? "Verify payment" : "Reject payment";
    $("#decision-dialog [data-decision-summary]").textContent = `${id} · ${store.donorName(
      donation.donorId
    )} · ${currency(donation.amountCents)}${
      duplicate.length
        ? ` · Possible duplicate reference: ${duplicate
            .map((item) => `${item.id} (${item.status})`)
            .join(", ")}`
        : ""
    }`;
    $("#decision-dialog [data-decision-label]").textContent = isVerification
      ? "Evidence note"
      : "Reason for rejection *";
    $("#decision-dialog [data-decision-help]").textContent = isVerification
      ? "Confirm only after reviewing payment evidence. This status is not checked with a bank or payment provider."
      : "Provide a reason so the rejection is documented in the activity log.";
    const note = $("#decision-note");
    note.required = !isVerification;
    note.value = isVerification ? donation.evidence || "Payment evidence reviewed" : "";
    $("#decision-dialog [data-decision-submit]").textContent = isVerification
      ? "Verify payment"
      : "Reject donation";
    $("#decision-dialog [data-decision-submit]").classList.toggle("btn-danger", !isVerification);
    $("#decision-dialog [data-decision-submit]").classList.toggle("btn-primary", isVerification);
    $("#decision-dialog").showModal();
  }
  function verifyDonation(id, evidence) {
    if (!["Finance Officer", "Administrator"].includes(state.currentUser?.role))
      throw new Error("Only Finance Officers and Administrators may verify payments.");
    const donation = state.donations.find((item) => item.id === id);
    if (!donation || donation.status !== "pending")
      throw new Error("This donation is no longer pending review.");
    donation.status = "verified";
    donation.verifiedAt = todayString();
    donation.evidence = evidence.trim() || "Evidence reviewed";
    store.audit(
      "Donation verified",
      id,
      `Verified payment for ${store.donorName(donation.donorId)}; evidence: ${donation.evidence}.`
    );
    store.save();
    $("#decision-dialog").close();
    sync();
    showToast("Payment verified. The donation is now included in verified totals.");
  }
  function rejectDonation(id, reason) {
    if (!["Finance Officer", "Administrator"].includes(state.currentUser?.role))
      throw new Error("Only Finance Officers and Administrators may reject payments.");
    const donation = state.donations.find((item) => item.id === id);
    if (!donation || donation.status !== "pending")
      throw new Error("This donation is no longer pending review.");
    if (!reason.trim()) throw new Error("A rejection reason is required.");
    donation.status = "rejected";
    donation.note = reason.trim();
    store.audit("Donation rejected", id, `Rejected payment: ${reason.trim()}.`);
    store.save();
    $("#decision-dialog").close();
    sync();
    showToast("Donation rejected and excluded from verified totals.");
  }
  function saveDecision(form) {
    const data = formData(form);
    if (!canPerform(data.decision))
      throw new Error("Your role is not permitted to review payments.");
    if (data.decision === "verify-donation") verifyDonation(data.id, data.note);
    else if (data.decision === "reject-donation") rejectDonation(data.id, data.note);
    else throw new Error("Unsupported payment decision.");
  }
  function issueReceipt(id) {
    const donation = state.donations.find((item) => item.id === id);
    if (!donation || donation.status !== "verified" || donation.eligible === false)
      throw new Error("A receipt can only be issued for an eligible verified donation.");
    if (state.receipts.some((receipt) => receipt.donationId === id))
      throw new Error("A receipt already exists for this donation.");
    const year = new Date().getFullYear();
    const next =
      state.receipts.reduce(
        (max, receipt) => Math.max(max, Number(receipt.id.match(/(\d+)$/)?.[1] || 0)),
        0
      ) + 1;
    const receipt = {
      id: `RCT-${year}-${String(next).padStart(4, "0")}`,
      donationId: id,
      issuedAt: todayString(),
      delivery: "not-sent",
      deliveredAt: "",
    };
    state.receipts.unshift(receipt);
    store.audit("Receipt issued", receipt.id, `Issued acknowledgment for donation ${id}.`);
    store.save();
    sync();
    showToast(`Receipt ${receipt.id} issued.`);
  }
  function viewReceipt(id) {
    const receipt = state.receipts.find((item) => item.id === id);
    const donation = state.donations.find((item) => item.id === receipt?.donationId);
    if (!receipt || !donation || donation.status !== "verified")
      throw new Error("Receipt is unavailable or its linked donation is not verified.");
    const donor = donorFor(donation.donorId);
    text($("[data-receipt-org]"), state.settings.orgName);
    text($("[data-receipt-id]"), `Acknowledgment receipt · ${receipt.id}`);
    text($("[data-receipt-donor]"), donor?.name || "Anonymous donor");
    text($("[data-receipt-amount]"), currency(donation.amountCents));
    text($("[data-receipt-date]"), formatDate(donation.date));
    text($("[data-receipt-program]"), donation.program);
    text($("[data-receipt-channel]"), donation.channel);
    $("#receipt-dialog").showModal();
  }
  function sendReceipt(id) {
    const receipt = state.receipts.find((item) => item.id === id);
    if (!receipt) throw new Error("Receipt was not found.");
    const donation = state.donations.find((item) => item.id === receipt.donationId);
    if (!donation || donation.status !== "verified")
      throw new Error("Only verified donations may have a delivered acknowledgment.");
    const donor = donorFor(donation.donorId);
    if (!donor?.email)
      throw new Error(
        "No donor email is recorded. Update the donor profile before simulating delivery."
      );
    receipt.delivery = "sent";
    receipt.deliveredAt = todayString();
    store.audit(
      "Receipt delivery simulated",
      receipt.id,
      `Marked acknowledgment delivered to ${donor.email}; no email was actually sent.`
    );
    store.save();
    sync();
    showToast(`Delivery marked for ${donor.email}. No email was sent.`);
  }
  function exportRows(rows, columns, filename) {
    if (!rows.length) throw new Error("There are no records to export.");
    const data = rows.map((row) => columns.map((column) => row[column] ?? ""));
    const csv = [columns, ...data]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
  function exportReport() {
    const rows = $$("tbody#report-donation-rows tr[data-searchable]:not([hidden])").map((row) => ({
      "Donation ID": row.cells[0].textContent,
      Donor: row.cells[1].textContent,
      Date: row.cells[2].textContent,
      Program: row.cells[3].textContent,
      "Payment channel": row.cells[4].textContent,
      "Amount PHP": row.cells[5].textContent.replace(/[^\d.,-]/g, ""),
      Status: row.cells[6].textContent,
    }));
    exportRows(
      rows,
      ["Donation ID", "Donor", "Date", "Program", "Payment channel", "Amount PHP", "Status"],
      `agapay-donations-${todayString()}.csv`
    );
    store.audit(
      "Report exported",
      "Donation register",
      `Exported ${rows.length} currently visible rows as CSV.`
    );
    showToast(`Exported ${rows.length} donation record${rows.length === 1 ? "" : "s"}.`);
  }
  function exportAudit() {
    exportRows(
      state.audit,
      ["at", "actor", "action", "entity", "detail"],
      `agapay-audit-${todayString()}.csv`
    );
    showToast("Audit log exported.");
  }
  function performAction(action, button) {
    const id = button.dataset.id;
    if (action === "close-dialog") return button.closest("dialog")?.close();
    if (action === "toggle-password") {
      const input = $(button.dataset.target);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      text(button, input.type === "password" ? "Show" : "Hide");
      return;
    }
    if (action === "sign-out") {
      if (state.currentUser) store.audit("Logout", state.currentUser.id, "User signed out.");
      state.currentUser = null;
      store.save();
      location.hash = "#login";
      return;
    }
    if (!canPerform(action)) throw new Error("Your role is not permitted to perform this action.");
    if (action === "new-donor") return openDialog("donor-dialog", $("#donor-form"), "Add donor");
    if (action === "edit-donor") {
      const donor = state.donors.find((item) => item.id === id);
      if (donor) openDialog("donor-dialog", $("#donor-form"), "Edit donor", donor);
      return;
    }
    if (action === "delete-donor") {
      const donor = state.donors.find((item) => item.id === id);
      if (!donor) return;
      if (state.donations.some((item) => item.donorId === id))
        throw new Error("This donor has linked donations and cannot be removed.");
      if (!window.confirm(`Remove ${donor.name} from the donor registry?`)) return;
      state.donors = state.donors.filter((item) => item.id !== id);
      store.audit("Donor removed", id, `Removed donor ${donor.name}.`);
      store.save();
      sync();
      showToast("Donor removed.");
      return;
    }
    if (action === "new-donation" || action === "edit-donation") {
      if (action === "new-donation" && !state.donors.length)
        throw new Error("Add a donor before recording a donation.");
      const donation =
        action === "edit-donation" ? state.donations.find((item) => item.id === id) : null;
      if (donation?.status === "verified")
        throw new Error("Verified donations are locked against routine editing.");
      if (donation) openDialog("donation-dialog", $("#donation-form"), "Edit donation", donation);
      else openDialog("donation-dialog", $("#donation-form"), "Record donation");
      return;
    }
    if (action === "cancel-donation") {
      const donation = state.donations.find((item) => item.id === id);
      if (!donation || donation.status !== "pending") return;
      if (!window.confirm(`Cancel pending donation ${id}?`)) return;
      donation.status = "cancelled";
      store.audit("Donation cancelled", id, `Cancelled pending donation ${id}.`);
      store.save();
      sync();
      showToast("Donation cancelled.");
      return;
    }
    if (action === "delete-donation") {
      const donation = state.donations.find((item) => item.id === id);
      if (!donation) return;
      if (
        donation.status === "verified" ||
        state.receipts.some((receipt) => receipt.donationId === id)
      ) {
        throw new Error(
          "Verified or receipted donations cannot be deleted. Cancel or correct records through an auditable workflow."
        );
      }
      if (!window.confirm(`Permanently remove donation ${id}? An audit entry will be retained.`))
        return;
      state.donations = state.donations.filter((item) => item.id !== id);
      store.audit(
        "Donation deleted",
        id,
        `Removed ${donation.status} donation ${id}; audit entry retained.`
      );
      store.save();
      sync();
      showToast("Donation removed.");
      return;
    }
    if (action === "verify-donation" || action === "reject-donation")
      return openDecisionDialog(action, id);
    if (action === "issue-receipt") return issueReceipt(id);
    if (action === "view-receipt") return viewReceipt(id);
    if (action === "send-receipt") return sendReceipt(id);
    if (action === "print-receipt") return window.print();
    if (action === "new-user") return openDialog("user-dialog", $("#user-form"), "Add user");
    if (action === "edit-user") {
      const user = state.users.find((item) => item.id === id);
      if (user) openDialog("user-dialog", $("#user-form"), "Edit user", user);
      return;
    }
    if (action === "toggle-user") {
      const user = state.users.find((item) => item.id === id);
      if (!user) return;
      if (user.id === state.currentUser?.id && user.status === "Active")
        throw new Error("You cannot deactivate your own account.");
      if (
        user.role === "Administrator" &&
        user.status === "Active" &&
        state.users.filter((item) => item.role === "Administrator" && item.status === "Active")
          .length <= 1
      ) {
        throw new Error("At least one active Administrator account must remain.");
      }
      user.status = user.status === "Active" ? "Inactive" : "Active";
      store.audit(
        `User ${user.status.toLowerCase()}`,
        id,
        `Marked ${user.name} ${user.status.toLowerCase()}.`
      );
      store.save();
      sync();
      showToast(`User ${user.status.toLowerCase()}.`);
      return;
    }
    if (action === "clear-records") {
      if (
        !window.confirm(
          "Clear all donor, donation, and receipt records from this browser? User accounts and settings will be kept. This cannot be undone."
        )
      )
        return;
      store.reset();
      store.audit(
        "Operational records cleared",
        "System",
        "Cleared all donors, donations, and receipts."
      );
      sync();
      showToast("Operational records cleared.");
      return;
    }
    if (action === "export-report") return exportReport();
    if (action === "export-audit") return exportAudit();
  }
  function sortTable(header) {
    const body = header.closest("table").tBodies[0];
    const column = [...header.parentElement.children].indexOf(header);
    const direction = header.dataset.sortDirection === "asc" ? "desc" : "asc";
    $$("th[data-sort-direction]").forEach((item) => {
      delete item.dataset.sortDirection;
      item.removeAttribute("aria-sort");
    });
    header.dataset.sortDirection = direction;
    header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
    const empty = $(".empty-row, .filter-empty", body);
    const rows = $$("tr[data-searchable]", body);
    rows.sort((a, b) => {
      const left = a.cells[column]?.textContent.trim() || "";
      const right = b.cells[column]?.textContent.trim() || "";
      const leftNumber = Number(left.replace(/[^\d.-]/g, ""));
      const rightNumber = Number(right.replace(/[^\d.-]/g, ""));
      const numeric =
        /[₱\d]/.test(left) &&
        /[₱\d]/.test(right) &&
        Number.isFinite(leftNumber) &&
        Number.isFinite(rightNumber);
      const comparison = numeric
        ? leftNumber - rightNumber
        : left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
      return direction === "asc" ? comparison : -comparison;
    });
    rows.forEach((row) => body.append(row));
    if (empty) body.append(empty);
  }

  document.addEventListener("click", (event) => {
    const header = event.target.closest("th[data-sortable]");
    if (header) return sortTable(header);
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
      performAction(button.dataset.action, button);
    } catch (error) {
      showToast(error.message || "The requested action could not be completed.", true);
    }
  });
  document.addEventListener("keydown", (event) => {
    const header = event.target.closest("th[data-sortable]");
    if (header && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      sortTable(header);
    }
    if (event.key === "Escape") $$(".modal[open]").forEach((dialog) => dialog.close());
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    event.preventDefault();
    try {
      const formName = form.getAttribute("id");
      if (formName === "login-form") {
        const data = Object.fromEntries(new FormData(form));
        const user = state.users.find(
          (item) =>
            item.email.toLowerCase() === data.email.trim().toLowerCase() && item.status === "Active"
        );
        if (!user)
          throw new Error("Username/email or password is incorrect, or the account is inactive.");
        let validPassword = (await passwordDigest(data.password, user.salt)) === user.passwordHash;
        if (
          !validPassword &&
          (await legacyPasswordDigest(data.password, user.salt)) === user.passwordHash
        ) {
          user.salt = newSalt();
          user.passwordHash = await passwordDigest(data.password, user.salt);
          validPassword = true;
        }
        if (!validPassword)
          throw new Error("Username/email or password is incorrect, or the account is inactive.");
        state.currentUser = { id: user.id, name: user.name, email: user.email, role: user.role };
        store.save();
        store.audit("Login", user.id, "User signed in.");
        location.hash = "#dashboard";
      } else if (formName === "decision-form") {
        saveDecision(form);
      } else {
        const id = form.elements.namedItem("id")?.value;
        const action = {
          "donor-form": id ? "edit-donor" : "new-donor",
          "donation-form": id ? "edit-donation" : "new-donation",
          "user-form": id ? "edit-user" : "new-user",
          "settings-form": "settings-form",
        }[formName];
        if (!action || !canPerform(action))
          throw new Error("Your role is not permitted to submit this form.");
        if (formName === "donor-form") saveDonor(form);
        else if (formName === "donation-form") saveDonation(form);
        else if (formName === "user-form") await saveUser(form);
        else if (formName === "settings-form") saveSettings(form);
      }
    } catch (error) {
      showToast(error.message || "The form could not be saved.", true);
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-search-table]")) applyFilters();
  });
  document.addEventListener("change", (event) => {
    if (
      event.target.matches(
        "[data-filter-status], [data-filter-program], [data-filter-type], [data-date-from], [data-date-to]"
      )
    )
      applyFilters();
  });
  window.addEventListener("hashchange", refresh);

  $$("th").forEach((header) => {
    header.dataset.sortable = "true";
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    header.setAttribute("aria-label", `Sort by ${header.textContent.trim()}`);
  });
  async function initialize() {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Could not load PostgreSQL data (${response.status}).`);
      }
      const { state: savedState } = await response.json();
      if (savedState) {
        if (
          savedState.version !== 2 ||
          !Array.isArray(savedState.users) ||
          !Array.isArray(savedState.donations) ||
          !Array.isArray(savedState.donors)
        )
          throw new Error("PostgreSQL contains invalid application data.");
        state = savedState;
      } else {
        state = load();
      }
      const previousBootstrap = state.users.find(
        (user) => user.demoAccount && user.email === "admin@agapay.local"
      );
      if (previousBootstrap) {
        previousBootstrap.name = "Administrator";
        previousBootstrap.email = "admin";
        previousBootstrap.role = "Administrator";
        previousBootstrap.status = "Active";
        previousBootstrap.salt = newSalt();
        previousBootstrap.passwordHash = await passwordDigest("admin123", previousBootstrap.salt);
        delete previousBootstrap.demoAccount;
        previousBootstrap.passwordChangedAt = "";
      }
      if (!state.users.length) {
        const salt = newSalt();
        state.users = [
          {
            id: "USR-1001",
            name: "Administrator",
            email: "admin",
            role: "Administrator",
            status: "Active",
            salt,
            passwordHash: await passwordDigest("admin123", salt),
            passwordChangedAt: "",
          },
        ];
      }
      state.currentUser = null;
      await store.save();
      if (localStorage.getItem(LEGACY_KEY)) localStorage.removeItem(LEGACY_KEY);
      populateDonorOptions();
      $("#donation-date").max = todayString();
      if (!state.currentUser) location.hash = "#login";
      refresh();
    } catch (error) {
      showToast(error.message || "Could not initialize the local system.", true);
    }
  }
  initialize();
})();