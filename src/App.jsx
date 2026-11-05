import { useEffect, useMemo, useState } from "react";
import {
  getSnapshot,
  initializeLocalDatabase,
  restoreSnapshot,
  reversePayment,
  saveMember,
  savePayment,
  saveSettings,
  validateBackup
} from "./database.js";
import { describeError, logEvent, readDiagnosticLogs, runLogChain } from "./logger.js";

const navigation = [
  ["dashboard", "◫", "Dashboard"],
  ["members", "♙", "Members"],
  ["record", "＋", "Record payment"],
  ["history", "▤", "Payment history"],
  ["reports", "▥", "Reports"],
  ["settings", "⚙", "Settings"]
];
const today = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const currentMonth = () => today().slice(0, 7);
const currency = (cents = 0) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(cents / 100);
const prettyMonth = (month) => month ? new Date(`${month}-02T00:00:00`).toLocaleDateString("en-ZA", { month: "long", year: "numeric" }) : "—";
const fullName = (member) => `${member.first_name} ${member.surname}`;

function downloadJson(data, fileName) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvDownload(rows, fileName) {
  const quote = (value) => {
    const text = String(value ?? "");
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replaceAll('"', '""')}"`;
  };
  const body = rows.map((row) => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${body}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printReport() {
  const cleanup = () => document.body.classList.remove("printing-report");
  document.body.classList.add("printing-report");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [clock, setClock] = useState(() => new Date());
  const [storagePersistent, setStoragePersistent] = useState(null);
  const [notice, setNotice] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [memberSearch, setMemberSearch] = useState("");
  const [memberEdit, setMemberEdit] = useState(null);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [historyFilter, setHistoryFilter] = useState({ query: "", month: "", from: "", to: "", method: "" });
  const [reportYear, setReportYear] = useState(String(new Date().getFullYear()));
  const [importBusy, setImportBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(readDiagnosticLogs);

  const refresh = async () => setSnapshot(await getSnapshot());
  useEffect(() => {
    let mounted = true;
    runLogChain("app.bootstrap", async (chain) => {
      chain.info("app.local_database.status.loading");
      return initializeLocalDatabase();
    }).then(async (status) => {
      if (!mounted) return;
      setSnapshot(await getSnapshot());
      if (status.migratedCounts) {
        setNotice(`Migrated ${status.migratedCounts.members} members and ${status.migratedCounts.payments} payments into local browser storage.`);
      }
    }).catch((cause) => {
      if (mounted) {
        setError(describeError(cause).message);
        setDiagnostics(readDiagnosticLogs());
      }
    }).finally(() => {
      if (mounted) setBusy(false);
    });
    const onDiagnosticLog = (event) => setDiagnostics((entries) => [...entries, event.detail].slice(-250));
    window.addEventListener("bafwethu:diagnostic-log", onDiagnosticLog);
    logEvent("info", "app.page.loaded", { isolated: window.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined" });
    if (navigator.storage?.persist) {
      navigator.storage.persist().then((granted) => {
        if (mounted) {
          setStoragePersistent(granted);
          logEvent(granted ? "info" : "warn", "storage.persistence.result", { granted });
        }
      }).catch((cause) => {
        console.warn("Persistent storage request failed", cause);
        if (mounted) {
          setStoragePersistent(false);
          logEvent("warn", "storage.persistence.failed", { message: cause.message });
        }
      });
    } else {
      setStoragePersistent(false);
      logEvent("warn", "storage.persistence.unsupported");
    }
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const clockTimer = window.setInterval(() => setClock(new Date()), 60_000);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      mounted = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(clockTimer);
      window.removeEventListener("bafwethu:diagnostic-log", onDiagnosticLog);
    };
  }, []);

  const members = snapshot?.members ?? [];
  const payments = snapshot?.payments ?? [];
  const settings = snapshot?.society_settings ?? {};
  const reversals = snapshot?.payment_reversals ?? [];
  const auditLogs = snapshot?.audit_logs ?? [];
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const reversedIds = useMemo(() => new Set(reversals.map((item) => item.payment_id)), [reversals]);
  const activeMembers = members.filter((member) => member.status === "Active");
  const membersDue = activeMembers.filter((member) => member.joined_at.slice(0, 7) <= month);
  const paymentsForMonth = payments.filter((payment) => payment.contribution_month === month && !reversedIds.has(payment.id));
  const monthCollected = paymentsForMonth.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const monthlyCents = Number(settings.monthly_contribution_cents) || 0;
  const paidAmounts = new Map();
  for (const payment of paymentsForMonth) {
    paidAmounts.set(payment.member_id, (paidAmounts.get(payment.member_id) || 0) + payment.amount_cents);
  }
  const paidMemberIds = new Set([...paidAmounts].filter(([, amount]) => amount >= monthlyCents).map(([id]) => id));
  const outstandingCount = membersDue.filter((member) => !paidMemberIds.has(member.id)).length;
  const totalCollected = payments.reduce((sum, payment) => sum + (reversedIds.has(payment.id) ? 0 : payment.amount_cents), 0);

  const complete = async (operation, successMessage) => {
    setError("");
    setNotice("");
    try {
      await runLogChain("app.action", async () => {
        await operation();
        await refresh();
      });
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (cause) {
      setError(describeError(cause).message || "The operation could not be completed.");
      return false;
    }
  };

  const filteredMembers = members.filter((member) =>
    `${member.member_no} ${member.first_name} ${member.surname}`.toLowerCase().includes(memberSearch.toLowerCase())
  );
  const filteredPayments = payments.filter((payment) => {
    const member = memberById.get(payment.member_id);
    const haystack = `${member?.member_no} ${member ? fullName(member) : ""} ${payment.receipt_no} ${payment.reference}`.toLowerCase();
    return (!historyFilter.query || haystack.includes(historyFilter.query.toLowerCase()))
      && (!historyFilter.month || payment.contribution_month === historyFilter.month)
      && (!historyFilter.from || payment.paid_at >= historyFilter.from)
      && (!historyFilter.to || payment.paid_at <= historyFilter.to)
      && (!historyFilter.method || payment.method === historyFilter.method);
  }).sort((a, b) => b.paid_at.localeCompare(a.paid_at));

  const showReceipt = (payment) => setSelectedReceipt({
    ...payment,
    member: memberById.get(payment.member_id),
    reversal: reversals.find((item) => item.payment_id === payment.id)
  });

  const exportBackup = async () => {
    await complete(async () => {
      const backedUpAt = new Date().toISOString();
      await saveSettings({ last_backup_at: backedUpAt });
      const data = await getSnapshot();
      downloadJson(data, `bafwethu-backup-${backedUpAt.slice(0, 10)}.json`);
    }, "Backup downloaded. Keep a copy somewhere separate from this device.");
  };

  const restoreFile = async (file) => {
    if (!file) return;
    setImportBusy(true);
    try {
      const data = JSON.parse(await file.text());
      validateBackup(data);
      const backupDate = data.backup_created_at ? new Date(data.backup_created_at).toLocaleString("en-ZA") : "unknown date";
      if (!window.confirm(`Restore backup from ${backupDate} with ${data.members.length} members and ${data.payments.length} payments? Your current local data will be replaced. A safety copy will be downloaded first.`)) return;
      const safetyCopy = await getSnapshot();
      downloadJson(safetyCopy, `bafwethu-safety-${today()}.json`);
      await restoreSnapshot(data);
      await refresh();
      logEvent("info", "backup.restore.completed", { members: data.members.length, payments: data.payments.length });
      setNotice("Backup restored successfully. Your previous data was downloaded as a safety copy.");
      setError("");
    } catch (cause) {
      logEvent("error", "backup.restore.failed", describeError(cause));
      setError(describeError(cause).message || "The backup could not be restored.");
    } finally {
      setImportBusy(false);
    }
  };

  const handleReverse = async (payment) => {
    const reason = window.prompt(`Reason for reversing receipt ${payment.receipt_no}:`);
    if (!reason?.trim()) return;
    if (!window.confirm(`Reverse ${payment.receipt_no}? The payment will remain in the audit history.`)) return;
    await complete(() => reversePayment(payment.id, reason), "Payment reversed and retained in the audit history.");
  };

  if (busy) return <div className="screen-state"><div className="spinner" /><p>Opening local society records…</p></div>;
  if (!snapshot) return <div className="screen-state startup-error"><strong>Local storage unavailable</strong><p>{error || "The browser could not initialize society records."}</p><p>Open this app in a supported browser over localhost or HTTPS. Existing browser data has not been changed.</p></div>;

  return (
    <div className="app-shell" style={{ "--navy": settings.primary_color || "#14263d", "--gold": settings.secondary_color || "#d9ae54" }}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div><strong>{settings.society_name || "BAFWETHU SOCIETY"}</strong><span>CONTRIBUTIONS</span></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(([key, icon, label]) => (
            <button key={key} type="button" aria-label={label} title={label} className={`nav-item ${page === key ? "active" : ""}`} onClick={() => { setPage(key); setError(""); setNotice(""); }}>
              <span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-text">{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="side-avatar">A</div>
          <div><strong>Administrator</strong><span>Local workspace</span></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">Society <span>/</span> {navigation.find((item) => item[0] === page)?.[2] || "Outstanding members"}</div>
          <div className="topbar-right">
            <span className={`connection-pill ${online ? "is-online" : "is-offline"}`}><i />{online ? "Online" : "Offline — local data available"}</span>
            <span className="today-label">{clock.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · {clock.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</span>
            <div className="top-avatar">A</div>
          </div>
        </header>
        <div className="content">
          {error && <div className="alert alert-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
          {notice && <div className="alert alert-success" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
          {storagePersistent === false && <div className="alert alert-warning" role="status">This browser could not confirm persistent storage. Download backups regularly; browser data may be cleared.</div>}
          {page === "dashboard" && <Dashboard
            month={month} setMonth={setMonth} members={members} activeMembers={activeMembers} membersDue={membersDue}
            payments={payments} paymentsForMonth={paymentsForMonth} monthCollected={monthCollected}
            paidMemberIds={paidMemberIds} outstandingCount={outstandingCount} totalCollected={totalCollected}
            monthlyCents={monthlyCents} memberById={memberById} reversedIds={reversedIds}
            onNavigate={setPage} onViewMonthPayments={() => { setHistoryFilter((previous) => ({ ...previous, month })); setPage("history"); }}
            onViewOutstanding={() => setPage("outstanding")} onReceipt={showReceipt} lastBackup={settings.last_backup_at}
          />}
          {page === "members" && <MembersPage
            members={filteredMembers} query={memberSearch} setQuery={setMemberSearch}
            onEdit={setMemberEdit} onNew={() => setMemberEdit({})}
          />}
          {page === "record" && <RecordPaymentPage
            members={activeMembers} monthlyCents={monthlyCents}
            onSave={(input, additional) => complete(async () => {
              const id = await savePayment(input, additional);
              await refresh();
              const fresh = await getSnapshot();
              const payment = fresh.payments.find((item) => item.id === id);
              const member = fresh.members.find((item) => item.id === payment.member_id);
              setSelectedReceipt({ ...payment, member });
              setNotice("Payment saved on this device. Back it up separately from Settings.");
            })}
          />}
          {page === "history" && <HistoryPage
            payments={filteredPayments} memberById={memberById} reversedIds={reversedIds}
            filter={historyFilter} setFilter={setHistoryFilter} onReceipt={showReceipt} onReverse={handleReverse}
          />}
          {page === "outstanding" && <OutstandingPage members={membersDue} payments={paymentsForMonth} monthlyCents={monthlyCents} month={month} />}
          {page === "reports" && <ReportsPage
            year={reportYear} setYear={setReportYear} members={members} payments={payments}
            memberById={memberById} reversals={reversals} monthlyCents={monthlyCents}
          />}
          {page === "settings" && <SettingsPage
            settings={settings} onSave={(values) => complete(() => saveSettings(values), "Society settings saved on this device.")}
            onExport={exportBackup} onImport={restoreFile} importBusy={importBusy}
            diagnostics={diagnostics} onExportDiagnostics={() => downloadJson(diagnostics, `bafwethu-diagnostics-${today()}.json`)}
            auditLogs={auditLogs}
          />}
        </div>
      </main>
      {memberEdit && <MemberDialog
        member={memberEdit.id ? members.find((item) => item.id === memberEdit.id) : null}
        onClose={() => setMemberEdit(null)}
        onSave={(input) => complete(async () => {
          await saveMember(input, memberEdit.id);
          setMemberEdit(null);
        }, memberEdit.id ? "Member details updated." : "New member added.")}
      />}
      {selectedReceipt && <ReceiptDialog
        payment={selectedReceipt}
        societyName={settings.society_name || "BAFWETHU SOCIETY"}
        tagline={settings.tagline || ""}
        onClose={() => setSelectedReceipt(null)}
      />}
    </div>
  );
}

function PageTitle({ eyebrow, title, subtitle, action }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

function Dashboard(props) {
  const {
    month, setMonth, members, activeMembers, membersDue, payments, paymentsForMonth, monthCollected,
    paidMemberIds, outstandingCount, totalCollected, monthlyCents, memberById, reversedIds,
    onNavigate, onViewMonthPayments, onViewOutstanding, onReceipt, lastBackup
  } = props;
  const recent = payments.filter((payment) => !reversedIds.has(payment.id)).sort((a, b) => b.paid_at.localeCompare(a.paid_at)).slice(0, 5);
  const chart = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(`${month}-01T00:00:00`);
    date.setMonth(date.getMonth() - (5 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const collected = payments.filter((payment) => payment.contribution_month === key && !reversedIds.has(payment.id)).reduce((sum, payment) => sum + payment.amount_cents, 0);
    const dueCount = activeMembers.filter((member) => member.joined_at.slice(0, 7) <= key).length;
    return { key, label: date.toLocaleDateString("en-ZA", { month: "short" }), collected, expected: dueCount * monthlyCents };
  });
  const chartMax = Math.max(1, ...chart.map((item) => item.expected), ...chart.map((item) => item.collected));
  return <>
    <PageTitle eyebrow="SOCIETY OVERVIEW" title="Dashboard" subtitle="A clear view of your society's contributions and members."
      action={<label className="month-picker">Contribution month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>} />
    <div className="backup-banner">
      <div className="backup-icon">↥</div>
      <div><strong>{lastBackup ? "Keep your records protected" : "Back up your local records"}</strong><span>{lastBackup ? `Last downloaded ${new Date(lastBackup).toLocaleString("en-ZA")}. Local changes may not be included.` : "Your data is stored on this device and has not been backed up yet."}</span></div>
      <button className="button button-outline" onClick={() => onNavigate("settings")}>Backup settings <span>→</span></button>
    </div>
    <div className="metric-grid">
      <Metric title="Total members" value={members.length} detail={`${activeMembers.length} active`} color="blue" icon="♙" onClick={() => onNavigate("members")} />
      <Metric title="Monthly contribution" value={currency(monthlyCents)} detail="Current standard amount" color="gold" icon="R" />
      <Metric title="Collected this month" value={currency(monthCollected)} detail={`${membersDue.filter((member) => paidMemberIds.has(member.id)).length} members fully paid`} color="green" icon="↗" onClick={onViewMonthPayments} />
      <Metric title="Outstanding members" value={outstandingCount} detail={`For ${prettyMonth(month)}`} color="orange" icon="!" onClick={onViewOutstanding} />
      <Metric title="Total funds collected" value={currency(totalCollected)} detail="All confirmed contributions" color="purple" icon="▤" />
    </div>
    <div className="dashboard-grid">
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Payment overview</h2><p>Collected contributions versus expected amount</p></div><span className="legend"><i className="legend-collected" /> Collected <i className="legend-expected" /> Expected</span></div>
        <div className="bar-chart" aria-label="Monthly collected and expected contribution chart">
          {chart.map((item) => <div className="bar-group" key={item.key}>
            <div className="bar-stack" title={`${item.label}: ${currency(item.collected)} collected, ${currency(item.expected)} expected`}>
              <div className="bar expected-bar" style={{ height: `${Math.max(4, item.expected / chartMax * 100)}%` }} />
              <div className="bar collected-bar" style={{ height: `${Math.max(item.collected ? 4 : 0, item.collected / chartMax * 100)}%` }} />
            </div><span>{item.label}</span>
          </div>)}
        </div>
        <div className="chart-footnote">Expected amount uses members who had joined by each month × {currency(monthlyCents)}.</div>
      </section>
      <section className="panel month-summary">
        <div className="panel-heading"><div><h2>{prettyMonth(month)}</h2><p>Contribution status</p></div><span className="summary-dot">●</span></div>
        <div className="summary-amount">{currency(monthCollected)}</div><div className="muted">Fully paid: {membersDue.filter((member) => paidMemberIds.has(member.id)).length} of {membersDue.length} eligible members</div>
        <div className="progress-track"><div style={{ width: `${activeMembers.length ? Math.min(100, paidMemberIds.size / activeMembers.length * 100) : 0}%` }} /></div>
        <div className="progress-caption"><span>{paidMemberIds.size} paid</span><span>{outstandingCount} outstanding</span></div>
        <button className="text-button" onClick={onViewMonthPayments}>View payment history <span>→</span></button>
      </section>
    </div>
    <section className="panel recent-panel">
      <div className="panel-heading"><div><h2>Recent payments</h2><p>Latest confirmed transactions</p></div><button className="text-button" onClick={() => onNavigate("history")}>View all <span>→</span></button></div>
      <div className="table-wrap"><table><thead><tr><th>Member</th><th>Contribution month</th><th>Payment date</th><th>Method</th><th className="right">Amount</th><th /></tr></thead>
        <tbody>{recent.length ? recent.map((payment) => {
          const member = memberById.get(payment.member_id);
          return <tr key={payment.id}><td><div className="member-cell"><div className="mini-avatar">{member?.first_name?.[0] || "?"}</div><div><strong>{member ? fullName(member) : "Unknown member"}</strong><small>#{member?.member_no || "—"}</small></div></div></td><td>{prettyMonth(payment.contribution_month)}</td><td>{payment.paid_at}</td><td><span className="method-tag">{payment.method}</span></td><td className="right amount-cell">{currency(payment.amount_cents)}</td><td><button className="icon-button" aria-label={`View receipt ${payment.receipt_no}`} onClick={() => onReceipt(payment)}>↗</button></td></tr>;
        }) : <tr><td colSpan="6" className="empty-cell">No payments recorded yet.</td></tr>}</tbody>
      </table></div>
    </section>
    <div className="footnote">Figures are calculated from this device's local database. {payments.length - reversedIds.size} active payment records.</div>
  </>;
}

function Metric({ title, value, detail, color, icon, onClick }) {
  const Content = <><div className={`metric-icon ${color}`}>{icon}</div><div className="metric-label">{title}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></>;
  return onClick ? <button className={`metric-card ${color}`} onClick={onClick}>{Content}</button> : <div className={`metric-card ${color}`}>{Content}</div>;
}

function MembersPage({ members, query, setQuery, onEdit, onNew }) {
  return <>
    <PageTitle eyebrow="MEMBER REGISTER" title="Members" subtitle="Manage member details and membership status."
      action={<button className="button button-primary" onClick={onNew}><span>＋</span> Add new member</button>} />
    <section className="panel">
      <div className="toolbar"><label className="search-field"><span>⌕</span><input aria-label="Search members" placeholder="Search name or member number" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span className="result-count">{members.length} members</span></div>
      <div className="table-wrap"><table><thead><tr><th>Member no.</th><th>Full name</th><th>Phone</th><th>Date joined</th><th>Status</th><th /></tr></thead>
        <tbody>{members.length ? members.map((member) => <tr key={member.id}>
          <td className="member-number">#{member.member_no}</td><td><div className="member-cell"><div className="mini-avatar">{member.first_name[0]}</div><div><strong>{fullName(member)}</strong><small>{member.email || "No email provided"}</small></div></div></td>
          <td>{member.phone}</td><td>{member.joined_at}</td><td><span className={`status-pill ${member.status.toLowerCase()}`}><i />{member.status}</span></td>
          <td><button className="button button-small button-outline" onClick={() => onEdit(member)}>Edit</button></td>
        </tr>) : <tr><td colSpan="6" className="empty-cell">No members found. Add the first member to get started.</td></tr>}</tbody>
      </table></div>
      <div className="table-footer">Member deletion is disabled to preserve payment history. Deactivate members instead.</div>
    </section>
  </>;
}

function MemberDialog({ member, onClose, onSave }) {
  const [form, setForm] = useState({
    first_name: member?.first_name || "", surname: member?.surname || "", phone: member?.phone || "",
    joined_at: member?.joined_at || today(), status: member?.status || "Active", email: member?.email || "", notes: member?.notes || ""
  });
  const [saving, setSaving] = useState(false);
  const change = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="dialog" onSubmit={submit} aria-labelledby="member-dialog-title">
      <div className="dialog-heading"><div><div className="eyebrow">{member ? "MEMBER REGISTER" : "NEW RECORD"}</div><h2 id="member-dialog-title">{member ? "Edit member" : "Add a member"}</h2></div><button type="button" className="icon-button close-button" onClick={onClose} aria-label="Close">×</button></div>
      {!member && <p className="form-note">A unique member number will be assigned automatically.</p>}
      <div className="form-grid">
        <Field label="First name" required><input autoFocus required value={form.first_name} onChange={change("first_name")} /></Field>
        <Field label="Surname" required><input required value={form.surname} onChange={change("surname")} /></Field>
        <Field label="Phone number" required><input required type="tel" value={form.phone} onChange={change("phone")} /></Field>
        <Field label="Date joined" required><input required type="date" value={form.joined_at} onChange={change("joined_at")} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={change("email")} /></Field>
        <Field label="Membership status"><select value={form.status} onChange={change("status")}><option>Active</option><option>Inactive</option></select></Field>
        <Field label="Notes" wide><textarea rows="3" value={form.notes} onChange={change("notes")} /></Field>
      </div>
      <div className="dialog-actions"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving…" : member ? "Save changes" : "Add member"}</button></div>
    </form>
  </div>;
}

function RecordPaymentPage({ members, monthlyCents, onSave }) {
  const [memberId, setMemberId] = useState("");
  const [form, setForm] = useState({ contribution_month: currentMonth(), amount: (monthlyCents / 100).toFixed(2), paid_at: today(), method: "EFT", reference: "", notes: "" });
  const [additional, setAdditional] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm((previous) => ({ ...previous, amount: (monthlyCents / 100).toFixed(2) })), [monthlyCents]);
  const member = members.find((item) => String(item.id) === String(memberId));
  const update = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (!memberId) return;
    setSaving(true);
    const saved = await onSave({ member_id: Number(memberId), contribution_month: form.contribution_month, amount_cents: Math.round(Number(form.amount) * 100), paid_at: form.paid_at, method: form.method, reference: form.reference, notes: form.notes }, additional);
    setSaving(false);
    if (!saved) return;
    setForm((previous) => ({ ...previous, reference: "", notes: "" }));
    setMemberId("");
    setAdditional(false);
  };
  return <>
    <PageTitle eyebrow="FINANCIAL TRANSACTIONS" title="Record a payment" subtitle="Payments are saved locally and do not require an internet connection." />
    {!members.length ? <div className="panel empty-state"><div className="empty-illustration">♙</div><h2>No active members yet</h2><p>Add an active member before recording a contribution.</p></div> :
      <form onSubmit={submit}>
        <div className="payment-grid">
          <section className="panel form-panel"><div className="panel-heading"><div className="step-heading"><span className="step-number">01</span><div><h2>Member details</h2><p>Select the member making this contribution.</p></div></div></div>
            <Field label="Member" required><select required value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Select a member</option>{members.map((item) => <option key={item.id} value={item.id}>#{item.member_no} — {fullName(item)}</option>)}</select></Field>
            {member ? <div className="selected-member"><div className="large-avatar">{member.first_name[0]}{member.surname[0]}</div><div><strong>{fullName(member)}</strong><span>Member #{member.member_no}</span><span>{member.phone}</span></div><span className="status-pill active"><i />Active</span></div> : <div className="select-hint">Member contact details will appear here after selection.</div>}
          </section>
          <section className="panel form-panel"><div className="panel-heading"><div className="step-heading"><span className="step-number">02</span><div><h2>Payment details</h2><p>Enter the contribution information.</p></div></div></div>
            <div className="form-grid">
              <Field label="Contribution month" required><input required type="month" value={form.contribution_month} onChange={update("contribution_month")} /></Field>
              <Field label="Amount (ZAR)" required><div className="input-prefix"><span>R</span><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={update("amount")} /></div></Field>
              <Field label="Payment date" required><input required type="date" value={form.paid_at} onChange={update("paid_at")} /></Field>
              <Field label="Payment method" required><select value={form.method} onChange={update("method")}><option>EFT</option><option>Cash</option><option>Bank Deposit</option><option>Other</option></select></Field>
              <Field label="Reference / transaction no." required={form.method === "EFT" || form.method === "Bank Deposit"}><input required={form.method === "EFT" || form.method === "Bank Deposit"} value={form.reference} onChange={update("reference")} /></Field>
              <Field label="Notes"><input value={form.notes} onChange={update("notes")} /></Field>
            </div>
            <label className="check-row"><input type="checkbox" checked={additional} onChange={(event) => setAdditional(event.target.checked)} /><span>Allow an additional or partial payment for this member and month</span></label>
          </section>
        </div>
        <div className="payment-submit"><div className="save-local"><span>✓</span><div><strong>Saved on this device</strong><small>Back up separately to protect against device loss.</small></div></div><div><button type="button" className="button button-outline" onClick={() => { setMemberId(""); setForm({ contribution_month: currentMonth(), amount: (monthlyCents / 100).toFixed(2), paid_at: today(), method: "EFT", reference: "", notes: "" }); }}>Clear</button> <button className="button button-primary" disabled={!memberId || saving}>{saving ? "Saving…" : "Save payment & issue receipt"}</button></div></div>
      </form>}
  </>;
}

function HistoryPage({ payments, memberById, reversedIds, filter, setFilter, onReceipt, onReverse }) {
  const set = (key) => (event) => setFilter((previous) => ({ ...previous, [key]: event.target.value }));
  const exportRows = [
    ["Payment date", "Member", "Member no.", "Contribution month", "Amount ZAR", "Method", "Receipt no.", "Status"],
    ...payments.map((payment) => {
      const member = memberById.get(payment.member_id);
      return [payment.paid_at, member ? fullName(member) : "", member?.member_no, payment.contribution_month, (payment.amount_cents / 100).toFixed(2), payment.method, payment.receipt_no, reversedIds.has(payment.id) ? "Reversed" : "Confirmed"];
    })
  ];
  return <>
    <PageTitle eyebrow="FINANCIAL TRANSACTIONS" title="Payment history" subtitle="Search, review, export or reverse recorded contributions."
      action={<button className="button button-outline" onClick={() => csvDownload(exportRows, "bafwethu-payment-history.csv")}>↓ Export CSV</button>} />
    <section className="panel">
      <div className="filter-row">
        <label className="search-field"><span>⌕</span><input placeholder="Search member or receipt no." value={filter.query} onChange={set("query")} /></label>
        <label className="compact-filter">Contribution month<input type="month" value={filter.month} onChange={set("month")} /></label>
        <label className="compact-filter">Method<select value={filter.method} onChange={set("method")}><option value="">All methods</option>{["EFT", "Cash", "Bank Deposit", "Other"].map((method) => <option key={method}>{method}</option>)}</select></label>
        <label className="compact-filter">From<input type="date" value={filter.from} onChange={set("from")} /></label>
        <label className="compact-filter">To<input type="date" value={filter.to} onChange={set("to")} /></label>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Payment date</th><th>Member</th><th>Contribution month</th><th>Method</th><th>Receipt no.</th><th>Status</th><th className="right">Amount</th><th>Actions</th></tr></thead>
        <tbody>{payments.length ? payments.map((payment) => {
          const member = memberById.get(payment.member_id);
          const reversed = reversedIds.has(payment.id);
          return <tr key={payment.id} className={reversed ? "reversed-row" : ""}><td>{payment.paid_at}</td><td>{member ? `${fullName(member)} · #${member.member_no}` : "Unknown member"}</td><td>{prettyMonth(payment.contribution_month)}</td><td><span className="method-tag">{payment.method}</span></td><td className="receipt-number">{payment.receipt_no}</td><td><span className={`status-pill ${reversed ? "inactive" : "active"}`}><i />{reversed ? "Reversed" : "Confirmed"}</span></td><td className="right amount-cell">{currency(payment.amount_cents)}</td><td><div className="table-actions"><button className="button button-small button-outline" onClick={() => onReceipt(payment)}>Receipt</button>{!reversed && <button className="button button-small button-danger" onClick={() => onReverse(payment)}>Reverse</button>}</div></td></tr>;
        }) : <tr><td colSpan="8" className="empty-cell">No payments match these filters.</td></tr>}</tbody></table></div>
      <div className="table-footer">{payments.length} records · Reversals remain visible for audit purposes.</div>
    </section>
  </>;
}

function OutstandingPage({ members, payments, monthlyCents, month }) {
  const totals = new Map();
  for (const payment of payments) totals.set(payment.member_id, (totals.get(payment.member_id) || 0) + payment.amount_cents);
  const outstanding = members.map((member) => ({
    member,
    paid: totals.get(member.id) || 0,
    owing: Math.max(0, monthlyCents - (totals.get(member.id) || 0))
  })).filter((item) => item.owing > 0);
  return <>
    <PageTitle eyebrow="CONTRIBUTION FOLLOW-UP" title="Outstanding members" subtitle={`Active members with an unpaid or partially paid contribution for ${prettyMonth(month)}.`} />
    <section className="panel">
      <div className="table-wrap"><table><thead><tr><th>Member no.</th><th>Member</th><th>Phone</th><th>Contribution month</th><th className="right">Paid</th><th className="right">Outstanding</th></tr></thead>
        <tbody>{outstanding.length ? outstanding.map(({ member, paid, owing }) => <tr key={member.id}><td className="member-number">#{member.member_no}</td><td>{fullName(member)}</td><td>{member.phone}</td><td>{prettyMonth(month)}</td><td className="right">{currency(paid)}</td><td className="right amount-cell">{currency(owing)}</td></tr>) : <tr><td colSpan="6" className="empty-cell">No active members have an outstanding balance for this month.</td></tr>}</tbody>
      </table></div>
      <div className="table-footer">{outstanding.length} outstanding of {members.length} eligible active members · Partial payments are included in the paid amount.</div>
    </section>
  </>;
}

function ReportsPage({ year, setYear, members, payments, memberById, reversals, monthlyCents }) {
  const [report, setReport] = useState("monthly");
  const reversedIds = new Set(reversals.map((item) => item.payment_id));
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
  const currentYear = String(new Date().getFullYear());
  const throughMonth = year < currentYear ? 12 : year === currentYear ? new Date().getMonth() + 1 : 0;
  const paidByMonth = (key) => payments.filter((payment) => payment.contribution_month === key && !reversedIds.has(payment.id)).reduce((sum, payment) => sum + payment.amount_cents, 0);
  const tableRows = report === "monthly"
    ? months.map((key, index) => {
      const expected = index + 1 <= throughMonth
        ? members.filter((member) => member.status === "Active" && member.joined_at.slice(0, 7) <= key).length * monthlyCents
        : 0;
      const collected = paidByMonth(key);
      return [prettyMonth(key), currency(expected), currency(collected), currency(Math.max(0, expected - collected))];
    })
    : report === "members"
      ? members.map((member) => {
        const paid = payments.filter((payment) => payment.member_id === member.id && payment.contribution_month.startsWith(year) && !reversedIds.has(payment.id)).reduce((sum, payment) => sum + payment.amount_cents, 0);
        const join = member.joined_at.slice(0, 7);
        const joinedYear = Number(join.slice(0, 4));
        const firstMonth = joinedYear === Number(year) ? Number(join.slice(5, 7)) : 1;
        const dueMonths = joinedYear > Number(year) ? 0 : Math.max(0, throughMonth - firstMonth + 1);
        const expected = dueMonths * monthlyCents;
        const status = member.status === "Inactive" ? "Inactive" : paid >= expected && expected > 0 ? "Paid" : paid > 0 ? "Partially paid" : "Unpaid";
        return [`#${member.member_no}`, fullName(member), member.status, currency(expected), currency(paid), status];
      })
      : payments.filter((payment) => payment.contribution_month.startsWith(year)).map((payment) => {
        const member = memberById.get(payment.member_id);
        return [payment.paid_at, member ? fullName(member) : "", prettyMonth(payment.contribution_month), currency(payment.amount_cents), payment.method, payment.receipt_no, reversedIds.has(payment.id) ? "Reversed" : "Confirmed"];
      });
  const headers = report === "monthly"
    ? ["Contribution month", "Expected", "Collected", "Outstanding"]
    : report === "members"
      ? ["Member no.", "Member", "Membership status", "Expected", "Collected", "Payment status"]
      : ["Payment date", "Member", "Contribution month", "Amount", "Method", "Receipt no.", "Status"];
  const exportRows = [headers, ...tableRows.map((row) => row.map((value) => String(value)))];
  return <>
    <PageTitle eyebrow="INSIGHTS & EXPORTS" title="Reports" subtitle="Financial reports use the same confirmed-payment and reversal rules as your dashboard."
      action={<div className="report-actions"><button className="button button-outline" onClick={printReport}>Print report</button><button className="button button-primary" onClick={() => csvDownload(exportRows, `bafwethu-${report}-${year}.csv`)}>↓ Export CSV</button></div>} />
    <section className="panel report-panel print-report">
      <div className="print-report-title"><h1>{report === "monthly" ? "Monthly contributions" : report === "members" ? "Member payment status" : "Payment transactions"} — {year}</h1><p>Bafwethu Society</p></div>
      <div className="report-controls"><div className="tab-group" role="tablist" aria-label="Report type">
        {[["monthly", "Monthly contributions"], ["members", "Member status"], ["payments", "Transactions"]].map(([key, label]) => <button role="tab" aria-selected={report === key} className={report === key ? "selected" : ""} key={key} onClick={() => setReport(key)}>{label}</button>)}
      </div><label className="compact-filter">Year<select value={year} onChange={(event) => setYear(event.target.value)}>{Array.from({ length: 8 }, (_, index) => String(new Date().getFullYear() - index)).map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="report-summary"><div><span>{report === "monthly" ? "Year collected" : report === "members" ? "Registered members" : "Transactions"}</span><strong>{report === "monthly" ? currency(months.reduce((sum, key) => sum + paidByMonth(key), 0)) : report === "members" ? members.length : tableRows.length}</strong></div><div><span>Report period</span><strong>{year}</strong></div><div><span>Reversed payments excluded from totals</span><strong>{reversals.length}</strong></div></div>
      <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{tableRows.length ? tableRows.map((row, index) => <tr key={`${index}-${row[0]}`}>{row.map((cell, cellIndex) => <td className={cellIndex === row.length - 1 && report === "monthly" ? "amount-cell" : ""} key={cellIndex}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length} className="empty-cell">No records for this report period.</td></tr>}</tbody></table></div>
      <div className="table-footer">Outstanding reflects expected monthly contributions less confirmed amounts received. Amounts are in ZAR.</div>
    </section>
  </>;
}

function SettingsPage({ settings, onSave, onExport, onImport, importBusy, diagnostics, onExportDiagnostics, auditLogs }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const update = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    await onSave({
      society_name: form.society_name.trim(),
      tagline: form.tagline.trim(),
      monthly_contribution_cents: String(Math.round(Number(form.monthly_amount) * 100)),
      contact_person: form.contact_person.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      primary_color: form.primary_color,
      secondary_color: form.secondary_color
    });
    setSaving(false);
  };
  return <>
    <PageTitle eyebrow="WORKSPACE CONFIGURATION" title="Settings" subtitle="Configure society details, contribution defaults, and local backup." />
    <div className="settings-layout">
      <form className="panel settings-form" onSubmit={submit}>
        <div className="panel-heading"><div><h2>Society information</h2><p>These details appear throughout the application and on receipts.</p></div></div>
        <div className="form-grid">
          <Field label="Society name" required><input required value={form.society_name || ""} onChange={update("society_name")} /></Field>
          <Field label="Tagline"><input value={form.tagline || ""} onChange={update("tagline")} /></Field>
          <Field label="Monthly contribution (ZAR)" required><div className="input-prefix"><span>R</span><input required type="number" min="0.01" step="0.01" value={form.monthly_amount ?? ((Number(form.monthly_contribution_cents || 0) / 100).toFixed(2))} onChange={update("monthly_amount")} /></div></Field>
          <Field label="Contact person"><input value={form.contact_person || ""} onChange={update("contact_person")} /></Field>
          <Field label="Phone number"><input type="tel" value={form.phone || ""} onChange={update("phone")} /></Field>
          <Field label="Email address"><input type="email" value={form.email || ""} onChange={update("email")} /></Field>
          <Field label="Primary colour"><div className="color-input"><input type="color" value={form.primary_color || "#14263d"} onChange={update("primary_color")} /><span>{form.primary_color || "#14263d"}</span></div></Field>
          <Field label="Accent colour"><div className="color-input"><input type="color" value={form.secondary_color || "#d9ae54"} onChange={update("secondary_color")} /><span>{form.secondary_color || "#d9ae54"}</span></div></Field>
        </div>
        <div className="settings-actions"><span>Changing the standard amount affects future payments only.</span><button className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button></div>
      </form>
      <section className="panel backup-panel"><div className="panel-heading"><div><h2>Backup & recovery</h2><p>Protect your local records from browser or device loss.</p></div></div>
        <div className="backup-status"><span className={`backup-status-icon ${settings.last_backup_at ? "success" : ""}`}>{settings.last_backup_at ? "✓" : "!"}</span><div><strong>{settings.last_backup_at ? "Last backup downloaded" : "No backup recorded"}</strong><span>{settings.last_backup_at ? new Date(settings.last_backup_at).toLocaleString("en-ZA") : "Download a JSON snapshot to get started."}</span></div></div>
        <div className="backup-explanation"><strong>Unencrypted local storage</strong><p>Your records are stored without a passphrase in this browser profile. Anyone with access to this device profile can view them. Payments work offline; download JSON backups regularly and keep them somewhere separate.</p></div>
        <button className="button button-primary full-button" onClick={onExport}>↓ Download JSON backup</button>
        <label className={`button button-outline full-button import-button ${importBusy ? "disabled" : ""}`}>{importBusy ? "Validating backup…" : "↑ Restore from JSON backup"}<input type="file" accept="application/json,.json" disabled={importBusy} onChange={(event) => { onImport(event.target.files?.[0]); event.target.value = ""; }} /></label>
        <div className="drive-notice"><strong>Google Drive connection</strong><p>Not connected. Drive backup requires an OAuth client ID configured for your deployment; no client secret belongs in this browser app. Local JSON export and restore are available now.</p><span className="status-pill inactive"><i />Not configured</span></div>
        <div className="diagnostics">
          <div className="diagnostics-heading"><div><strong>Diagnostic log</strong><span>{diagnostics.length} recent events stored on this device</span></div><button className="button button-small button-outline" onClick={onExportDiagnostics} disabled={!diagnostics.length}>Export log</button></div>
          <div className="diagnostics-list" aria-live="polite">
            {diagnostics.slice(-12).reverse().map((entry) => <div className="diagnostic-entry" key={`${entry.timestamp}-${entry.sequence}`}>
              <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString("en-ZA")}</time>
              <span className={`diagnostic-level ${entry.level}`}>{entry.level}</span>
              <span className="diagnostic-event">{entry.event}</span>
              {entry.chainId && <code>{entry.chainId.slice(0, 8)}</code>}
              {entry.details?.message && <span className="diagnostic-message">{entry.details.message}</span>}
            </div>)}
            {!diagnostics.length && <div className="diagnostics-empty">No diagnostic events yet.</div>}
          </div>
          <p className="diagnostics-note">Logs contain technical event names and errors, not member or payment details.</p>
        </div>
      </section>
    </div>
    <section className="panel activity-panel">
      <div className="panel-heading">
        <div><h2>Change history</h2><p>Successful member, payment, reversal, and settings changes recorded on this device.</p></div>
        <span className="result-count">{auditLogs.length} recorded changes</span>
      </div>
      <div className="table-wrap">
        <table><thead><tr><th>Date and time</th><th>Change</th><th>Record</th><th>Details</th><th>User</th></tr></thead>
          <tbody>{auditLogs.length ? [...auditLogs].reverse().slice(0, 25).map((entry) => <tr key={entry.id}>
            <td>{new Date(entry.created_at).toLocaleString("en-ZA")}</td>
            <td><span className="activity-action">{entry.action.replaceAll("_", " ")}</span></td>
            <td>{entry.record_type} · {entry.record_id}</td>
            <td>{entry.details}</td>
            <td>{entry.user_name}</td>
          </tr>) : <tr><td colSpan="5" className="empty-cell">No changes recorded yet. Saved changes will appear here.</td></tr>}</tbody>
        </table>
      </div>
      <div className="table-footer">Change history is stored in the local database, included in JSON backups, and available offline.</div>
    </section>
  </>;
}

function ReceiptDialog({ payment, societyName, tagline, onClose }) {
  return <div className="modal-backdrop receipt-backdrop" role="presentation">
    <div className="receipt-dialog">
      <div className="receipt-toolbar no-print"><span>Payment receipt</span><div><button className="button button-outline" onClick={() => window.print()}>Print / Save PDF</button><button className="icon-button close-button" onClick={onClose} aria-label="Close receipt">×</button></div></div>
      <article className="receipt-paper">
        <div className="receipt-brand"><div className="receipt-logo">B</div><div><strong>{societyName}</strong><span>{tagline}</span></div></div>
        <div className="receipt-title"><span>OFFICIAL PAYMENT RECEIPT</span><strong>{payment.receipt_no}</strong></div>
        {payment.reversal && <div className="reversal-stamp">REVERSED · {new Date(payment.reversal.reversed_at).toLocaleDateString("en-ZA")} · {payment.reversal.reason}</div>}
        <div className="receipt-amount"><span>AMOUNT RECEIVED</span><strong>{currency(payment.amount_cents)}</strong></div>
        <div className="receipt-details">
          <ReceiptRow label="Member" value={payment.member ? fullName(payment.member) : "Member record unavailable"} />
          <ReceiptRow label="Member number" value={payment.member?.member_no || "—"} />
          <ReceiptRow label="Contribution month" value={prettyMonth(payment.contribution_month)} />
          <ReceiptRow label="Payment date" value={payment.paid_at} />
          <ReceiptRow label="Payment method" value={payment.method} />
          <ReceiptRow label="Reference" value={payment.reference || "—"} />
        </div>
        <div className="receipt-thanks"><strong>Thank you for your contribution.</strong><span>{tagline}</span></div>
        <div className="receipt-foot">This receipt is generated from a locally saved transaction. Please retain it for your records.</div>
      </article>
    </div>
  </div>;
}

function ReceiptRow({ label, value }) { return <div className="receipt-row"><span>{label}</span><strong>{value}</strong></div>; }
function Field({ label, required, wide, children }) { return <label className={`field ${wide ? "wide" : ""}`}><span>{label}{required && <b> *</b>}</span>{children}</label>; }

export default App;
