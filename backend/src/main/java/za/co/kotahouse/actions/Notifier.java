package za.co.kotahouse.actions;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import za.co.kotahouse.whatsapp.WhatsApp;
import za.co.kotahouse.auth.Mailer;
import za.co.kotahouse.common.AfterCommit;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/**
 * Owner alerts (port of notify() in common.ts): a notification record in the
 * same transaction as the change, and, when switched on, an email sent once
 * the transaction has committed.
 */
@Component
public class Notifier {
  public static final String COLLECTION = "notifications";

  private final Store store;
  private final Mailer mailer;
  /** lazy: WhatsApp itself raises alerts through this class */
  private final ObjectProvider<WhatsApp> whatsapp;
  /** WhatsApp sends call Meta over the network, so they run off the request thread */
  private final ExecutorService background = Executors.newVirtualThreadPerTaskExecutor();

  public Notifier(Store store, Mailer mailer, ObjectProvider<WhatsApp> whatsapp) {
    this.store = store;
    this.mailer = mailer;
    this.whatsapp = whatsapp;
  }

  @jakarta.annotation.PreDestroy
  void stop() {
    background.shutdown();
  }

  /** One line of an alert's details; tone: good, warn, bad (or null). */
  public record Detail(String label, String value, String tone) {
    public Detail(String label, String value) {
      this(label, value, null);
    }
  }

  public record Alert(String type, String severity, String title, String message, List<Detail> details, String actorName, String action, String link) {}

  /** A fluent way to write alerts that reads like the original code. */
  public static Builder alert(String type, String severity, String title) {
    return new Builder(type, severity, title);
  }

  public static final class Builder {
    private final String type;
    private final String severity;
    private final String title;
    private String message = "";
    private final List<Detail> details = new ArrayList<>();
    private String actorName;
    private String action;
    private String link;

    Builder(String type, String severity, String title) {
      this.type = type;
      this.severity = severity;
      this.title = title;
    }

    public Builder message(String m) {
      message = m;
      return this;
    }

    public Builder detail(String label, String value) {
      details.add(new Detail(label, value));
      return this;
    }

    public Builder detail(String label, String value, String tone) {
      details.add(new Detail(label, value, tone));
      return this;
    }

    public Builder details(List<Detail> more) {
      details.addAll(more);
      return this;
    }

    public Builder actor(String name) {
      actorName = name;
      return this;
    }

    public Builder action(String a) {
      action = a;
      return this;
    }

    public Builder link(String l) {
      link = l;
      return this;
    }

    public Alert build() {
      return new Alert(type, severity, title, message, List.copyOf(details), actorName, action, link);
    }
  }

  public void notify(String businessId, Settings settings, Builder alert) {
    notify(businessId, settings, alert.build(), null);
  }

  /** With a fixed id, a repeated alert replaces the earlier one (e.g. one "out of stock" per item per day). */
  public void notify(String businessId, Settings settings, Builder alert, String id) {
    notify(businessId, settings, alert.build(), id);
  }

  public void notify(String businessId, Settings settings, Alert n, String id) {
    String docId = id != null ? id : store.newId();
    List<Map<String, Object>> details = new ArrayList<>();
    for (Detail d : n.details()) {
      if (d.value() == null || d.value().isEmpty()) continue;
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("label", d.label());
      m.put("value", d.value());
      if (d.tone() != null) m.put("tone", d.tone());
      details.add(m);
    }
    Map<String, Object> doc = new LinkedHashMap<>();
    doc.put("read", false);
    doc.put("createdAt", Op.serverTime());
    doc.put("type", n.type());
    doc.put("severity", n.severity());
    doc.put("title", n.title());
    doc.put("message", n.message());
    doc.put("details", details);
    if (n.actorName() != null) doc.put("actorName", n.actorName());
    if (n.action() != null) doc.put("action", n.action());
    if (n.link() != null) doc.put("link", n.link());
    store.set(businessId, COLLECTION, docId, doc);

    if ("info".equals(n.severity())) return;
    StringBuilder text = new StringBuilder(n.message()).append("\n\n");
    for (Map<String, Object> d : details) text.append(d.get("label")).append(": ").append(d.get("value")).append('\n');
    if (n.actorName() != null) text.append("By: ").append(n.actorName()).append('\n');
    if (n.action() != null) text.append("\nWhat to do: ").append(n.action()).append('\n');
    text.append("\nOpen the Kota House dashboard to review.");

    List<String> to = settings.emailTo();
    if (settings.flag("notifications", "email") && !to.isEmpty()) {
      String subject = "[" + settings.businessName() + "] " + n.title();
      AfterCommit.run(() -> to.forEach(addr -> mailer.send(addr, subject, text.toString())));
    }

    List<String> phones = settings.whatsappTo();
    String phoneNumberId = settings.text("whatsapp", "phoneNumberId");
    if (settings.flag("notifications", "whatsapp") && !phones.isEmpty() && !phoneNumberId.isEmpty()) {
      String message = ("critical".equals(n.severity()) ? "🚨 " : "⚠️ ") + "*" + settings.businessName() + ": " + n.title() + "*\n" + text;
      AfterCommit.run(() -> background.execute(() -> phones.forEach(p -> {
        try {
          whatsapp.getObject().send(businessId, phoneNumberId, p, message);
        } catch (RuntimeException e) {
          LoggerFactory.getLogger(Notifier.class).error("WhatsApp alert to {} failed", p, e);
        }
      })));
    }
  }
}
