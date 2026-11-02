package za.co.kotahouse.store;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Tells connected screens which collections of a shop changed, so their live
 * lists refresh (what Firestore's onSnapshot did). Changes are announced only
 * after the transaction commits; a rolled-back change is never announced.
 * One server for now; with several, this moves to PostgreSQL LISTEN/NOTIFY.
 */
@Component
public class ChangeFeed {
  private static final String RESOURCE = ChangeFeed.class.getName();

  private final Map<String, List<Consumer<Set<String>>>> listeners = new ConcurrentHashMap<>();

  /** Called by the store for every write (and by services that change staff records directly). */
  public void changed(String businessId, String collection) {
    if (!TransactionSynchronizationManager.isSynchronizationActive()) {
      publish(businessId, Set.of(collection));
      return;
    }
    @SuppressWarnings("unchecked")
    Map<String, Set<String>> pending = (Map<String, Set<String>>) TransactionSynchronizationManager.getResource(RESOURCE);
    if (pending == null) {
      Map<String, Set<String>> fresh = new ConcurrentHashMap<>();
      TransactionSynchronizationManager.bindResource(RESOURCE, fresh);
      TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
          fresh.forEach(ChangeFeed.this::publish);
        }

        @Override
        public void afterCompletion(int status) {
          TransactionSynchronizationManager.unbindResourceIfPossible(RESOURCE);
        }
      });
      pending = fresh;
    }
    pending.computeIfAbsent(businessId, k -> new HashSet<>()).add(collection);
  }

  private void publish(String businessId, Set<String> collections) {
    for (Consumer<Set<String>> l : listeners.getOrDefault(businessId, List.of())) l.accept(Set.copyOf(collections));
  }

  /** Returns a handle that stops listening. */
  public Runnable listen(String businessId, Consumer<Set<String>> listener) {
    listeners.computeIfAbsent(businessId, k -> new CopyOnWriteArrayList<>()).add(listener);
    return () -> listeners.getOrDefault(businessId, List.of()).remove(listener);
  }
}
