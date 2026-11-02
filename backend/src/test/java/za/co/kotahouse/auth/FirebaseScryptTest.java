package za.co.kotahouse.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class FirebaseScryptTest {
  // The published example from https://github.com/firebase/scrypt
  private static final FirebaseScrypt.Params EXAMPLE = new FirebaseScrypt.Params(
      "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==", "Bw==", 8, 14);
  private static final String SALT = "42xEC+ixf3L2lw==";
  private static final String HASH = "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==";

  @Test
  void matchesFirebasesPublishedExample() {
    assertThat(FirebaseScrypt.verify("user1password", SALT, HASH, EXAMPLE)).isTrue();
  }

  @Test
  void rejectsWrongPasswordOrMissingConfig() {
    assertThat(FirebaseScrypt.verify("user1password ", SALT, HASH, EXAMPLE)).isFalse();
    assertThat(FirebaseScrypt.verify("user1password", SALT, HASH, new FirebaseScrypt.Params("", "Bw==", 8, 14))).isFalse();
    assertThat(FirebaseScrypt.verify("user1password", "not base64!", HASH, EXAMPLE)).isFalse();
  }
}
