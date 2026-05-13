# Deploy

**Recommended path: AWS EKS for the sandbox cluster, Render for the
single web service.** The codebase ships scripts and a Render Blueprint
for exactly this combo. The reconciler / warm-pool / SessionEvent
subscriber loops that used to live in a separate `litellm-agents-worker`
Render service now run inside the Next.js process via
`src/instrumentation.ts` — one container, one deploy unit.

## Architecture

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────────┐
│   web    │──▶│ postgres │   │ litellm prox │──▶│  model API   │
│ (Render) │   │ (Render  │   │   (yours)    │   │              │
│ + worker │   │  or Neon)│   └──────▲───────┘   └──────────────┘
│  loops   │   └──────────┘          │
└────┬─────┘                         │
     │           ┌──────────────────┐│
     └── kube ──▶│    AWS EKS       ││
        API      │ + agent-sandbox  ││
                 │      CRD         ││
                 └──────────────────┘
```

## Steps

1. **Provision EKS** (~15 min, one-time):
   ```bash
   AWS_ACCESS_KEY_ID=AKIA... \
   AWS_SECRET_ACCESS_KEY=... \
   AWS_REGION=us-east-1 \
     bin/eks-up.sh > kube-config.b64
   ```
   Set `K8S_NODE_HOST=auto` on the web service (recommended). Platform
   discovers a Ready node ExternalIP via the apiserver at spawn time
   and caches for 30s — survives nodegroup scales and node replacements.
   The script prints a sample IP for sanity-checking only.

   The kubeconfig that `bin/eks-up.sh` emits uses an `aws-iam-authenticator`
   exec-plugin block — it carries no bearer token and never expires. The
   binary is downloaded into the build artifact by both the Dockerfile
   and `render.yaml`'s `buildCommand`. The same AWS credentials you used
   to run the script must also be set on the Render service as
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, because
   the exec-plugin reads them from the process env at every k8s API call.

2. **Push the harness image** to ECR (or any registry your cluster nodes
   can pull from):
   ```bash
   ECR="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com"
   aws ecr create-repository --repository-name opencode-sandbox || true
   aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR"
   docker build -t "$ECR/opencode-sandbox:latest" harnesses/opencode/
   docker push "$ECR/opencode-sandbox:latest"
   ```

3. **Deploy to Render** via the 1-click button in
   [`render/README.md`](render/README.md). Paste:
   - `KUBE_CONFIG_B64=$(cat kube-config.b64)`
   - `K8S_NODE_HOST=auto`
   - `K8S_HARNESS_IMAGE=$ECR/opencode-sandbox:latest`
   - `LITELLM_API_BASE`, `LITELLM_API_KEY`, `LITELLM_DEFAULT_MODEL`

That's it. The first reconcile tick (running inside the web service)
fills the warm pool; spawns land in <2s once primed.

For a scripted / agent-driven deploy, see
[`render/AGENTS.md`](render/AGENTS.md).

## Required env

Set on the `web` service. The 1-click flow handles auto-generated
values; everything else is paste-once.

```ini
DATABASE_URL=                     # Render-provisioned, or your Neon
MASTER_KEY=                       # auto-gen by render.yaml
UI_USERNAME=admin

LITELLM_API_BASE=
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

KUBE_CONFIG_B64=                  # bin/eks-up.sh output (exec-plugin kubeconfig — never expires)
AWS_ACCESS_KEY_ID=                # consumed by aws-iam-authenticator at every k8s API call
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1

K8S_NODE_HOST=auto                # platform discovers Ready node IP at spawn time (recommended)
K8S_HARNESS_IMAGE=                # ECR path

K8S_NAMESPACE=default
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=32767
K8S_IMAGE_PULL_POLICY=IfNotPresent

PREINSTALLED_GITHUB_REPO=https://github.com/BerriAI/litellm
WARM_POOL_SIZE=2
```

## Rotations

- **MASTER_KEY** rotates by setting a new value in Render dashboard.
- **AWS access keys** rotate like any IAM credential — drop the new pair
  into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` on the Render web
  service. No kubeconfig regeneration needed; the exec-plugin re-reads
  env on the next call. (If you switch to a new IAM principal entirely,
  re-run `bin/eks-up.sh` once so the new principal is mapped in the
  cluster's `aws-auth` ConfigMap.)

## Other clouds / providers

The platform speaks vanilla Kubernetes via the
[kubernetes-sigs/agent-sandbox] CRD. GKE, AKS, on-prem, k3s — all work
if you bring a kubeconfig that the platform can dial. The recommended
path above is what we test against.

[kubernetes-sigs/agent-sandbox]: https://github.com/kubernetes-sigs/agent-sandbox
