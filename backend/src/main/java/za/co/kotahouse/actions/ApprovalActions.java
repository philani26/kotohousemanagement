package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.map;
import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** Owner approvals and staff expenses (port of approvals.ts and expenses.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Approvals and expenses")
public class ApprovalActions {
  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Effects effects;
  private final Notifier notifier;
  private final AuditLog audit;

  public ApprovalActions(Ctx ctx, Store store, SettingsService settingsService, Effects effects, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.effects = effects;
    this.notifier = notifier;
    this.audit = audit;
  }

  @Operation(summary = "Approve or reject a request", description = """
      Owner only. The effect of an approval (refund paid, expense counted, stock corrected) is applied in the same \
      transaction, so an approval is never recorded without its effect. Rejecting needs a note.""")
  @PostMapping("/decideApproval")
  @Transactional
  public Map<String, Object> decideApproval(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    boolean approve = d.bool("approve");
    String note = d.optText("note", "Note", 300);
    if (!approve && note == null) throw ApiException.invalid("Give a reason for rejecting");
    String approvalId = d.str("approvalId");
    Map<String, Object> approval = store.getForUpdate(b, "approvals", approvalId).orElseThrow(() -> ApiException.notFound("Approval not found"));
    if (!"pending".equals(approval.get("status"))) throw ApiException.precondition("This request has already been decided");
    Settings settings = settingsService.read(b);
    String refId = str(approval.get("refId"));
    String type = str(approval.get("type"));

    switch (type) {
      case "refund" -> {
        Map<String, Object> sale = store.getForUpdate(b, "sales", refId).orElseThrow(() -> ApiException.notFound("Sale not found"));
        Map<String, Object> session = null;
        if (approve && Domain.cashPartCents(map(sale.get("payment")), cents(sale.get("totalCents"))) > 0) {
          var open = store.listForUpdate(b, Query.of("cashSessions").where("status", "==", "open").limit(1).build());
          if (open.isEmpty()) throw ApiException.precondition("Approve cash refunds while a shift is open, so the cash paid back is counted in the till");
          session = open.get(0);
        }
        if (approve) {
          effects.applyRefund(b, sale, session, owner, null);
        } else {
          store.update(b, "sales", refId, Map.of("status", "completed", "refund.decidedBy", owner.uid(), "refund.decidedAt", Op.serverTime(), "refund.rejected", true));
        }
      }
      case "expense" -> {
        Map<String, Object> expense = store.getForUpdate(b, "expenses", refId).orElseThrow(() -> ApiException.notFound("Expense not found"));
        Object shiftId = expense.get("shiftId");
        Map<String, Object> session = shiftId == null ? null : store.getForUpdate(b, "cashSessions", str(shiftId)).orElse(null);
        effects.applyExpenseDecision(b, expense, session, approve, owner, note);
      }
      case "stockAdjustment" -> {
        Map<String, Object> ingredient = store.getForUpdate(b, "ingredients", refId).orElseThrow(() -> ApiException.notFound("Ingredient not found"));
        if (approve) {
          Map<String, Object> payload = map(approval.get("payload"));
          double qtyChange = num(payload.get("qtyChange"));
          long value = effects.applyStockChange(b, owner, settings, new Effects.StockChange(ingredient, qtyChange, "adjustment",
              payload.get("reason") + " (approved)", "approval", approvalId, str(payload.get("shiftId")), null, null), Map.of());
          effects.bumpStats(b, Effects.todayKey(settings), Map.of("stockAdjustmentCents", Op.inc(Math.signum(qtyChange) * value)));
        }
      }
      default -> throw ApiException.invalid("Unknown request type");
    }

    Map<String, Object> decided = new LinkedHashMap<>();
    decided.put("status", approve ? "approved" : "rejected");
    decided.put("decidedBy", owner.uid());
    decided.put("decidedByName", owner.name());
    decided.put("decidedAt", Op.serverTime());
    if (note != null) decided.put("note", note);
    store.update(b, "approvals", approvalId, decided);
    Map<String, Object> details = new LinkedHashMap<>();
    details.put("type", type);
    details.put("refId", refId);
    details.put("amountCents", approval.get("amountCents"));
    details.put("note", note);
    audit.record(owner, "approval." + (approve ? "approved" : "rejected"), "approvals", approvalId, details);
    return Map.of("ok", true);
  }

  @Operation(summary = "Record an expense", description = """
      A cashier's expense waits for the owner's approval; only approved till expenses reduce the expected cash. \
      The owner's expenses are approved straight away. receiptPath comes from POST /api/shops/{b}/files.""")
  @PostMapping("/submitExpense")
  @Transactional
  public Map<String, Object> submitExpense(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    long amount = d.cents("amountCents", "Amount", 1, 100_000_000);
    String description = d.text("description", "Description", 3, 300);
    String receiptPath = receiptPath(d.optText("receiptPath", "Receipt", 300), c);
    String date = d.str("date");
    if (!date.matches("^\\d{4}-\\d{2}-\\d{2}$")) throw Domain.error("Invalid expense date");
    String category = d.str("category");
    boolean fromTill = d.bool("paidFromTill");

    Settings settings = settingsService.read(b);
    if (!(settings.data().get("expenseCategories") instanceof java.util.List<?> cats) || !cats.contains(category)) {
      throw Domain.error("Choose a valid expense category");
    }
    if (date.compareTo(Effects.todayKey(settings)) > 0) throw Domain.error("Expense date cannot be in the future");
    Map<String, Object> session = null;
    if (fromTill) {
      Map<String, Object> shift = effects.findOpenShift(c).orElseThrow(() -> ApiException.precondition("A shift must be open to pay an expense from the till"));
      session = store.getForUpdate(b, "cashSessions", str(shift.get("cashSessionId"))).orElseThrow();
    }

    String expenseId = store.newId();
    String approvalId = store.newId();
    boolean isOwner = c.isOwner();
    Map<String, Object> expense = new LinkedHashMap<>();
    expense.put("amountCents", amount);
    expense.put("category", category);
    expense.put("description", description);
    expense.put("date", date);
    expense.put("paidFromTill", fromTill);
    if (receiptPath != null) expense.put("receiptPath", receiptPath);
    expense.put("status", isOwner ? "approved" : "submitted");
    expense.put("shiftId", session == null ? null : session.get("id"));
    expense.put("submittedBy", c.uid());
    expense.put("submittedByName", c.name());
    expense.put("approvalId", approvalId);
    expense.put("createdAt", Op.serverTime());
    if (isOwner) expense.put("decision", Map.of("by", c.uid(), "byName", c.name(), "at", Op.serverTime(), "note", "Recorded by owner"));
    store.set(b, "expenses", expenseId, expense);

    Map<String, Object> approval = new LinkedHashMap<>();
    approval.put("type", "expense");
    approval.put("status", isOwner ? "approved" : "pending");
    approval.put("refId", expenseId);
    approval.put("summary", category + ": " + description + (fromTill ? " (paid from till)" : ""));
    approval.put("amountCents", amount);
    approval.put("payload", Map.of("category", category, "paidFromTill", fromTill, "hasReceipt", receiptPath != null));
    approval.put("requestedBy", c.uid());
    approval.put("requestedByName", c.name());
    approval.put("requestedAt", Op.serverTime());
    if (isOwner) {
      approval.put("decidedBy", c.uid());
      approval.put("decidedByName", c.name());
      approval.put("decidedAt", Op.serverTime());
    }
    store.set(b, "approvals", approvalId, approval);

    if (session != null) store.update(b, "cashSessions", str(session.get("id")), Map.of(isOwner ? "approvedCashExpensesCents" : "pendingCashExpensesCents", Op.inc(amount)));
    if (isOwner) {
      effects.bumpStats(b, date, Map.of(Effects.expenseStatsField(category), Op.inc(amount)));
    } else {
      notifier.notify(b, settings, Notifier.alert("pendingExpense", "warning", "Expense to approve: " + formatZar(amount))
          .message(c.name() + " – " + category + ": " + description + (fromTill ? " (cash from till)" : "") + (receiptPath != null ? "" : " – no receipt"))
          .detail("Amount", formatZar(amount))
          .detail("Category", category)
          .detail("What for", description)
          .detail("Date of expense", date)
          .detail("Paid with", fromTill ? "Cash from the till" : "Not from the till")
          .detail("Receipt photo", receiptPath != null ? "Attached – view it in Approvals" : "None attached", receiptPath != null ? "good" : "bad")
          .detail("Submitted", Days.localTime(Instant.now(), settings.timezone()))
          .actor(c.name())
          .action(fromTill
              ? "Approve or reject in Approvals. Until you approve, this cash is not subtracted from the expected till balance."
              : "Approve or reject in Approvals.")
          .link("/approvals"));
    }
    audit.record(c, "expense.submitted", "expenses", expenseId, Map.of("amountCents", amount, "category", category, "paidFromTill", fromTill));
    return Map.of("expenseId", expenseId);
  }

  /** Uploads live under businesses/{b}/receipts/{uid}/…, and a person may only attach their own. */
  static String receiptPath(String path, Caller c) {
    if (path == null) return null;
    String prefix = "businesses/" + c.businessId() + "/receipts/" + c.uid() + "/";
    if (!path.startsWith(prefix) || path.contains("..") || path.length() > 300) throw Domain.error("Invalid receipt upload");
    return path;
  }
}
