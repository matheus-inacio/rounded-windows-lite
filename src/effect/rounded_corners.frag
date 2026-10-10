#define BORDER_COLOR vec4(0.2, 0.2, 0.2, 1.0)

uniform vec4 bounds;
uniform vec4 borderedAreaBounds; 

uniform float clipRadius;
uniform float borderedAreaClipRadius;

uniform float showBorder;
uniform vec2 actorSize; 

// ClutterShaderEffect (GNOME 51+) uploads every uniform as a single vecN, so
// uniform arrays are not supported. The 3 shadow layers are packed in vectors.
uniform vec4 shadowOffset01; // xy = layer 0 offset, zw = layer 1 offset
uniform vec2 shadowOffset2;  // layer 2 offset
uniform vec3 shadowSigma;
uniform vec3 shadowSpread;
uniform vec3 shadowOpacity;

float getPointAlpha(vec2 p, vec4 bndInfo, float rad) {
    vec2 q = abs(p - bndInfo.xy) - (bndInfo.zw - rad);
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    return clamp(0.5 - (dist - rad), 0.0, 1.0);
}

vec2 erf(vec2 x) {
    vec2 s = sign(x), a = abs(x);
    x = vec2(1.0) + (vec2(0.278393) + (vec2(0.230389) + vec2(0.078108) * (a * a)) * a) * a;
    x *= x;
    return s - s / (x * x);
}

float gaussian(float x, float invSigmaSqrt2Pi, float invTwoSigmaSq) {
    return exp((x * x) * invTwoSigmaSq) * invSigmaSqrt2Pi;
}

float roundedBoxShadowX(float x, float y, float invSigmaSqrt2, float corner, vec2 halfSize) {
    float delta = min(halfSize.y - corner - abs(y), 0.0);
    float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
    vec2 integral = vec2(0.5) + vec2(0.5) * erf((vec2(x) + vec2(-curved, curved)) * invSigmaSqrt2);
    return integral.y - integral.x;
}

float roundedBoxShadow(vec2 point, vec2 halfSize, float sigma, float corner) {
    if (sigma < 0.01) {
        vec2 q = abs(point) - (halfSize - corner);
        float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
        return clamp(0.5 - dist, 0.0, 1.0);
    }

    // 2D bounding-box rejection: Gaussian blur drops to ~0 beyond 4*sigma
    vec2 maxDist = halfSize + vec2(4.0 * sigma);
    if (abs(point.x) > maxDist.x || abs(point.y) > maxDist.y) {
        return 0.0;
    }

    float lowerBound = point.y - halfSize.y;
    float upperBound = point.y + halfSize.y;
    
    float start = clamp(-4.0 * sigma, lowerBound, upperBound);
    float end = clamp(4.0 * sigma, lowerBound, upperBound);

    if (start >= end) {
        return 0.0;
    }

    float stepSize = (end - start) / 24.0;
    float y = start + stepSize * 0.5;
    float accumulatedValue = 0.0;
    
    // Precompute expensive divisions OUTSIDE the 24-step loop
    float invSigmaSqrt2Pi = 1.0 / (2.50662827 * sigma);
    float invTwoSigmaSq = -1.0 / (2.0 * sigma * sigma);
    float invSigmaSqrt2 = 0.70710678 / sigma;
    
    for (int i = 0; i < 24; i++) {
        accumulatedValue += roundedBoxShadowX(point.x, point.y - y, invSigmaSqrt2, corner, halfSize) * gaussian(y, invSigmaSqrt2Pi, invTwoSigmaSq) * stepSize;
        y += stepSize;
    }

    return accumulatedValue;
}

float shadowLayerAlpha(vec2 p, vec2 offset, float sigma, float spread, float opacity) {
    if (opacity <= 0.0) {
        return 0.0;
    }

    vec2 center = bounds.xy + offset;
    vec2 halfSize = bounds.zw + spread;
    float corner = max(clipRadius + spread, 0.0);

    float alpha = roundedBoxShadow(p - center, halfSize, sigma, corner);
    return clamp(alpha, 0.0, 1.0) * (opacity / 100.0);
}

void main() {
    vec2 p = cogl_tex_coord_in[0].xy * actorSize;

    vec4 windowColor = cogl_color_out;
    float pointAlpha = getPointAlpha(p, bounds, clipRadius);
    windowColor *= pointAlpha; 
    
    // Major GPU Optimization: Only compute multi-layer Gaussian shadows if the
    // fragment is outside the window or on the antialiased edge. Inside the window,
    // pointAlpha == 1.0, so (1.0 - pointAlpha) is 0 and shadow is completely discarded.
    if (pointAlpha < 1.0) {
        float totalShadowAlpha = 0.0;
        float alpha;

        alpha = shadowLayerAlpha(p, shadowOffset01.xy, shadowSigma.x, shadowSpread.x, shadowOpacity.x);
        totalShadowAlpha = totalShadowAlpha + alpha * (1.0 - totalShadowAlpha);

        alpha = shadowLayerAlpha(p, shadowOffset01.zw, shadowSigma.y, shadowSpread.y, shadowOpacity.y);
        totalShadowAlpha = totalShadowAlpha + alpha * (1.0 - totalShadowAlpha);

        alpha = shadowLayerAlpha(p, shadowOffset2, shadowSigma.z, shadowSpread.z, shadowOpacity.z);
        totalShadowAlpha = totalShadowAlpha + alpha * (1.0 - totalShadowAlpha);
        
        vec4 shadowColorPremult = vec4(0.0, 0.0, 0.0, totalShadowAlpha);
        cogl_color_out = windowColor + shadowColorPremult * (1.0 - pointAlpha);
    } else {
        cogl_color_out = windowColor;
    }

    float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);
    float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0) * showBorder;
    
    cogl_color_out = mix(cogl_color_out, vec4(BORDER_COLOR.rgb, 1.0), borderAlpha * BORDER_COLOR.a);
}