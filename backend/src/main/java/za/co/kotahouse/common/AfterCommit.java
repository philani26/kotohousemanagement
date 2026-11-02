package za.co.kotahouse.common;

import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Runs side effects outside the database (e.g. the Firebase mirror) only once the transaction has committed. */
public final class AfterCommit {
  private AfterCommit() {}

  public static void run(Runnable r) {
    if (!TransactionSynchronizationManager.isSynchronizationActive()) {
      r.run();
      return;
    }
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
      @Override
      public void afterCommit() {
        r.run();
      }
    });
  }
}
