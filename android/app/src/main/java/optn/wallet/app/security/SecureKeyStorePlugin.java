package optn.wallet.app.security;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureKeyStore")
public class SecureKeyStorePlugin extends Plugin {
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "optn_wallet_data_key_v1";
  private static final int GCM_TAG_LENGTH = 128;
  private static final int GCM_IV_LENGTH = 12;

  private SecretKey getOrCreateSecretKey() throws Exception {
    KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
    keyStore.load(null);
    SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    if (existing != null) {
      return existing;
    }

    KeyGenerator keyGenerator = KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES,
      ANDROID_KEYSTORE
    );
    KeyGenParameterSpec keySpec = new KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .setUserAuthenticationRequired(false)
      .build();
    keyGenerator.init(keySpec);
    return keyGenerator.generateKey();
  }

  @PluginMethod
  public void encrypt(PluginCall call) {
    try {
      String plaintext = call.getString("plaintext", "");
      SecretKey secretKey = getOrCreateSecretKey();

      byte[] iv = new byte[GCM_IV_LENGTH];
      new SecureRandom().nextBytes(iv);

      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH, iv));
      byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

      byte[] merged = new byte[iv.length + encrypted.length];
      System.arraycopy(iv, 0, merged, 0, iv.length);
      System.arraycopy(encrypted, 0, merged, iv.length, encrypted.length);

      JSObject ret = new JSObject();
      ret.put("ciphertext", Base64.encodeToString(merged, Base64.NO_WRAP));
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("Encryption failed", e);
    }
  }

  @PluginMethod
  public void decrypt(PluginCall call) {
    try {
      String ciphertext = call.getString("ciphertext", "");
      byte[] merged = Base64.decode(ciphertext, Base64.DEFAULT);
      if (merged.length <= GCM_IV_LENGTH) {
        call.reject("Ciphertext is invalid");
        return;
      }

      byte[] iv = new byte[GCM_IV_LENGTH];
      byte[] encrypted = new byte[merged.length - GCM_IV_LENGTH];
      System.arraycopy(merged, 0, iv, 0, GCM_IV_LENGTH);
      System.arraycopy(merged, GCM_IV_LENGTH, encrypted, 0, encrypted.length);

      SecretKey secretKey = getOrCreateSecretKey();
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH, iv));
      byte[] plaintext = cipher.doFinal(encrypted);

      JSObject ret = new JSObject();
      ret.put("plaintext", new String(plaintext, StandardCharsets.UTF_8));
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("Decryption failed", e);
    }
  }
}
