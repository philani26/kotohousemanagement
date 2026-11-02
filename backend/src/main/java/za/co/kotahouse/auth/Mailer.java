package za.co.kotahouse.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Sends emails (password reset). Development logs them; production uses Amazon SES (SES wiring comes with the AWS deployment). */
public interface Mailer {
  void send(String to, String subject, String text);

  /** Development: the email is written to the log instead of being sent. */
  class LogMailer implements Mailer {
    private static final Logger log = LoggerFactory.getLogger(LogMailer.class);

    @Override
    public void send(String to, String subject, String text) {
      log.info("EMAIL to {} – {}\n{}", to, subject, text);
    }
  }
}
