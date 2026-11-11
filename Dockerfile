FROM nginx:alpine

# Gaussian Splat gallery — static viewer (Three.js + GaussianSplats3D),
# served with the correct MIME type for .ksplat binary assets and
# aggressive caching since these files never change once deployed
# (new splats = new filename via add_splat.sh, not an in-place edit).

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY viewer/ /usr/share/nginx/html/

EXPOSE 80
