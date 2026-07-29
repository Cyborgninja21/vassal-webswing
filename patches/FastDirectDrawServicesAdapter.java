package org.webswing.services.impl.ddutil;

import net.jpountz.xxhash.StreamingXXHash64;
import net.jpountz.xxhash.XXHashFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.webswing.directdraw.DirectDrawServicesAdapter;
import org.webswing.directdraw.util.ImageConsumerAdapter;
import org.webswing.services.impl.ImageServiceImpl;

import java.awt.Font;
import java.awt.Image;
import java.awt.image.BufferedImage;
import java.awt.image.ColorModel;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Patched copy of Webswing 26.4.5's adapter, spliced into
 * webswing-app-services.jar at image build (see docker/Dockerfile).
 *
 * Why: directdraw's ImageConst constructor PNG-encodes AND pixel-hashes every
 * image on every drawImage call — the constant pool only dedupes AFTER both
 * costs are paid. VASSAL's map paint issues dozens of tile drawImages per
 * repaint with the SAME immutable tile Image objects, so a drag re-encoded and
 * re-hashed the identical pixels ~10 times a second: mid-drag thread dumps
 * showed the EDT pinned here, ~80 of every 95 ms per frame, one core burned,
 * 10 fps. Two changes:
 *
 *  1. A weak-keyed identity memo of {png, hash} per Image. Sound for VASSAL,
 *     whose tile/piece images are decoded once and never mutated. Guarded by a
 *     size floor so Swing's small recycled painter caches (CachedPainter can
 *     repaint content into an existing image) stay on the always-recompute
 *     path; a mutated LARGE image would ship stale pixels, which VASSAL never
 *     does.
 *  2. XXHashFactory.fastestJavaInstance() instead of the hardcoded
 *     safeInstance() — the unsafe-based implementation for first-time hashes.
 */
public class FastDirectDrawServicesAdapter extends DirectDrawServicesAdapter {
  private static final Logger log = LoggerFactory.getLogger(FastDirectDrawServicesAdapter.class);
  XXHashFactory hashfactory = XXHashFactory.fastestJavaInstance();
  Set<String> missingFonts = new HashSet<>();
  long seed = 12345L;

  private static final int MEMO_MIN_PIXELS = 128 * 128;
  private final Map<Image, byte[]> pngMemo = Collections.synchronizedMap(new WeakHashMap<>());
  private final Map<Image, Long> hashMemo = Collections.synchronizedMap(new WeakHashMap<>());

  private static boolean memoizable(Image img) {
    int w = img.getWidth(null);
    int h = img.getHeight(null);
    return w > 0 && h > 0 && w * h >= MEMO_MIN_PIXELS;
  }

  @Override
  public byte[] getPngImage(BufferedImage imageContent) {
    if (!memoizable(imageContent)) {
      return ImageServiceImpl.getInstance().getPngImage(imageContent);
    }
    byte[] cached = pngMemo.get(imageContent);
    if (cached != null) {
      return cached;
    }
    byte[] png = ImageServiceImpl.getInstance().getPngImage(imageContent);
    pngMemo.put(imageContent, png);
    return png;
  }

  @Override
  public long getSignature(byte[] data) {
    return hashfactory.hash64().hash(data, 0, data.length, seed);
  }

  @Override
  public long computeHash(Image subImage) {
    if (!memoizable(subImage)) {
      return computeHashUncached(subImage);
    }
    Long cached = hashMemo.get(subImage);
    if (cached != null) {
      return cached;
    }
    long hash = computeHashUncached(subImage);
    hashMemo.put(subImage, hash);
    return hash;
  }

  private long computeHashUncached(Image subImage) {
    final StreamingXXHash64 shash = hashfactory.newStreamingHash64(seed);
    final ByteBuffer byteBuffer = ByteBuffer.allocate(subImage.getWidth(null) * 4);
    final IntBuffer intBuffer = byteBuffer.asIntBuffer();

    ImageConsumerAdapter ic = new ImageConsumerAdapter() {
      @Override
      public void setPixels(int x, int y, int w, int h, ColorModel model, int[] pixels, int off,
          int scansize) {
        intBuffer.rewind();
        intBuffer.put(pixels, off, scansize);
        shash.update(byteBuffer.array(), 0, scansize * 4);
      }

      public void setPixels(int x, int y, int w, int h, ColorModel model, byte[] pixels, int off,
          int scansize) {
        shash.update(pixels, 0, scansize);
      }

      public void setDimensions(int width, int height) {
        final ByteBuffer byteBuffer = ByteBuffer.allocate(8);
        final IntBuffer intBuffer = byteBuffer.asIntBuffer();
        intBuffer.rewind();
        intBuffer.put(width);
        intBuffer.put(height);

        shash.update(byteBuffer.array(), 0, 8);
      }
    };
    subImage.getSource().startProduction(ic);
    return shash.getValue();
  }

  @Override
  public String getFileForFont(Font font) {
    String fileForFont = super.getFileForFont(font);
    if (fileForFont == null && !missingFonts.contains(font.getFontName())) {
      missingFonts.add(font.getFontName());
      String fontFamily = font.getFamily();
      if (fontFamily.startsWith("Dialog") || fontFamily.startsWith("Monospaced")
          || fontFamily.startsWith("Serif") || fontFamily.startsWith("SansSerif")) {
        log.warn(
            "Logical font {} not defined in font configuration. Using default browser counterpart.",
            font.getFontName());
      } else {
        log.warn("Font {} not defined in font configuration. Falling back to glyph rendering.",
            font.getFontName());
      }
    }
    return fileForFont;
  }
}
