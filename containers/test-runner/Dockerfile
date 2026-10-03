# Test container for the git-flare merge queue. Started with internet access disabled: the composed tree
# arrives as a tar stream on stdin. Install commands run as root; test commands run as the unprivileged `node`
# user through su-exec. tini is PID 1 so that processes killed between runs are reaped, not left as zombies.
# Add the toolchains your repositories' tests need here.
FROM node:22-alpine
RUN apk add --no-cache git bash tar su-exec tini
RUN mkdir -p /workspace
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
