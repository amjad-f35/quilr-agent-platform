#!/usr/bin/env bash
set -euo pipefail

# First run: scaffold .env from .env.example, seed a random MASTER_KEY, exit.
# User fills in AWS + LiteLLM creds, re-runs.
if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    KEY=$(openssl rand -hex 32)
    sed -i.bak "s|^MASTER_KEY=.*|MASTER_KEY=$KEY|" .env && rm -f .env.bak
  fi
  cat <<'EOF'

✓ created .env from .env.example with a random MASTER_KEY.

Open .env and fill in:
  • AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (need ECS/ECR/EC2/IAM/Logs/STS)
  • LITELLM_API_BASE, LITELLM_API_KEY

Then re-run: ./setup.sh

EOF
  exit 0
fi

set -a
source .env  # AWS_REGION, AWS_CLUSTER, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
set +a

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REPO=litellm-agents-opencode
TAG=$(git rev-parse --short HEAD)
IMAGE_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:$TAG"
ROLE=litellm-agents-task-exec
LOG_GROUP=/ecs/litellm-agents
SG=litellm-agents-sg
FAMILY=litellm-agents-opencode

# 1. ECR repo
aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" 2>/dev/null \
  || aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION"

# 2. Docker build + push
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
docker build --platform linux/amd64 -f harnesses/opencode/Dockerfile -t "$IMAGE_URI" harnesses/opencode
docker push "$IMAGE_URI"

# 3. IAM exec role (idempotent)
aws iam get-role --role-name "$ROLE" 2>/dev/null || aws iam create-role \
  --role-name "$ROLE" --assume-role-policy-document file://setup/trust-policy.json
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# 4. Log group
aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "$AWS_REGION" \
  | grep -q "$LOG_GROUP" || aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$AWS_REGION"

# 5. ECS cluster
aws ecs describe-clusters --clusters "$AWS_CLUSTER" --region "$AWS_REGION" \
  --query "clusters[?status=='ACTIVE']" --output text | grep -q . \
  || aws ecs create-cluster --cluster-name "$AWS_CLUSTER" --region "$AWS_REGION"

# 6. Default VPC + public subnet + SG
VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query "Vpcs[0].VpcId" --region "$AWS_REGION" --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID Name=map-public-ip-on-launch,Values=true \
  --query "Subnets[0].SubnetId" --region "$AWS_REGION" --output text)
SG_ID=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG Name=vpc-id,Values=$VPC_ID \
  --query "SecurityGroups[0].GroupId" --region "$AWS_REGION" --output text 2>/dev/null || echo "")
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name "$SG" --vpc-id "$VPC_ID" \
    --description "litellm managed agents" --region "$AWS_REGION" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 4096 --cidr 0.0.0.0/0 --region "$AWS_REGION"
fi

# 7. Register task def
TASK_DEF_ARN=$(aws ecs register-task-definition --region "$AWS_REGION" \
  --family "$FAMILY" --network-mode awsvpc --requires-compatibilities FARGATE \
  --cpu 512 --memory 1024 \
  --execution-role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE" \
  --runtime-platform '{"cpuArchitecture":"X86_64","operatingSystemFamily":"LINUX"}' \
  --container-definitions "$(cat <<JSON
[{"name":"harness","image":"$IMAGE_URI","essential":true,
  "portMappings":[{"containerPort":4096,"protocol":"tcp"}],
  "logConfiguration":{"logDriver":"awslogs","options":{
    "awslogs-group":"$LOG_GROUP","awslogs-region":"$AWS_REGION","awslogs-stream-prefix":"harness"}}}]
JSON
)" --query "taskDefinition.taskDefinitionArn" --output text)

# 8. Write outputs into .env in-place (replace if key present, append if not).
update_env() {
  local key="$1" val="$2" file=".env"
  if [ ! -f "$file" ]; then
    echo "$key=$val" >> "$file"
    return
  fi
  if grep -q "^${key}=" "$file"; then
    # `|` is a safe sed delimiter — ARNs and image URIs use `:` and `/`.
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "${file}.bak"
  else
    echo "$key=$val" >> "$file"
  fi
}

update_env AWS_TASK_DEFINITION_ARN "$TASK_DEF_ARN"
update_env AWS_SUBNETS              "$SUBNET_ID"
update_env AWS_SECURITY_GROUP       "$SG_ID"
update_env OPENCODE_IMAGE_URI       "$IMAGE_URI"

cat <<EOF

✓ wrote into .env:
  AWS_TASK_DEFINITION_ARN=$TASK_DEF_ARN
  AWS_SUBNETS=$SUBNET_ID
  AWS_SECURITY_GROUP=$SG_ID
  OPENCODE_IMAGE_URI=$IMAGE_URI
EOF
