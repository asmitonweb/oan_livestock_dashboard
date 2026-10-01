// Registry dashboard: verify, build the image, push it to ECR, and deploy
// develop to the dev cluster with Helm (namespace of the registry it belongs
// to). Other branches verify, build and push only. See docs/deployment.md.
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timeout(time: 60, unit: 'MINUTES')
    }

    environment {
        AWS_ACCOUNT_ID = "${env.AWS_ACCOUNT_ID}"   // global Jenkins variable
        AWS_REGION     = "ap-south-1"
        ECR_REGISTRY   = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
        ECR_REPOSITORY = "openg2p/livestock-registry-dashboard"
        // A Docker login of this build's own: other pipelines on the same node
        // run `docker logout` in their post steps.
        DOCKER_CONFIG  = "${env.WORKSPACE}@tmp/docker-config"

        HELM_RELEASE   = "livestock-registry-dashboard"
        HELM_NAMESPACE = "live"
        HELM_CHART_DIR = "helm/livestock-registry-dashboard"
        // Kubeconfig credential for the namespace's deploy identity on the dev cluster.
        DEV_KUBECONFIG = "gen2-dev-livestock-kubeconfig"
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Verify') {
            // Lint and type-check in a throwaway Node container; `npm run build`
            // in the image build below type-checks again and compiles.
            steps {
                sh '''
                    docker run --rm -v "$PWD:/src:ro" node:20-slim sh -ec '
                        cp -r /src /work && cd /work
                        npm ci --no-audit --no-fund
                        npm run lint
                        npm run typecheck
                    '
                '''
            }
        }

        stage('ECR Login') {
            steps {
                withCredentials([[$class: 'AmazonWebServicesCredentialsBinding', credentialsId: 'aws-ecr-creds']]) {
                    sh "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}"
                    sh """
                        aws ecr describe-repositories --region ${AWS_REGION} --repository-names ${ECR_REPOSITORY} >/dev/null 2>&1 \
                          || { echo "ECR repository ${ECR_REPOSITORY} does not exist: create it once in ${AWS_REGION} (see docs/deployment.md)"; exit 1; }
                    """
                }
            }
        }

        stage('Build & Push') {
            steps {
                script {
                    env.IMAGE_TAG = env.GIT_COMMIT.take(12)
                    def image = "${ECR_REGISTRY}/${ECR_REPOSITORY}"
                    // develop and staging also move a tag of their own name.
                    def moving = (env.BRANCH_NAME in ['develop', 'staging']) ? "-t ${image}:${env.BRANCH_NAME}" : ''
                    sh """
                        docker build \
                            --label org.opencontainers.image.revision=${env.GIT_COMMIT} \
                            --label org.opencontainers.image.ref.name=${env.BRANCH_NAME} \
                            -t ${image}:${env.IMAGE_TAG} ${moving} .
                        docker push ${image}:${env.IMAGE_TAG}
                        ${moving ? "docker push ${image}:${env.BRANCH_NAME}" : ''}
                    """
                }
            }
        }

        stage('Stash chart') {
            when { branch 'develop' }
            steps { stash name: 'chart', includes: "${HELM_CHART_DIR}/**" }
        }

        stage('Deploy (dev)') {
            // Only vpn-agent2 reaches the cluster API.
            when {
                beforeAgent true
                branch 'develop'
            }
            agent { label 'vpn-agent2' }
            steps {
                unstash 'chart'
                withCredentials([file(credentialsId: env.DEV_KUBECONFIG, variable: 'KUBECONFIG')]) {
                    sh """
                        set -e
                        helm template ${HELM_RELEASE} ${HELM_CHART_DIR} -n ${HELM_NAMESPACE} \
                            -f ${HELM_CHART_DIR}/values-dev.yaml \
                            --set image.repository=${ECR_REGISTRY}/${ECR_REPOSITORY} \
                            --set image.tag=${env.IMAGE_TAG} >/dev/null
                        helm upgrade --install ${HELM_RELEASE} ${HELM_CHART_DIR} -n ${HELM_NAMESPACE} \
                            -f ${HELM_CHART_DIR}/values-dev.yaml \
                            --set image.repository=${ECR_REGISTRY}/${ECR_REPOSITORY} \
                            --set image.tag=${env.IMAGE_TAG} \
                            --wait --timeout 10m
                        kubectl rollout status deployment/${HELM_RELEASE} -n ${HELM_NAMESPACE} --timeout=180s

                        # Ready only means the server answers: check that it reaches its
                        # dashboard-api, through the Service (API server proxy).
                        echo "=== smoke test ==="
                        HEALTH=\$(kubectl get --raw "/api/v1/namespaces/${HELM_NAMESPACE}/services/${HELM_RELEASE}:http/proxy/api/health")
                        echo "\$HEALTH"
                        echo "\$HEALTH" | grep -q '"status":"ok"' || { echo "dashboard cannot reach its dashboard-api"; exit 1; }
                        echo "Deployed ${HELM_RELEASE} ${env.IMAGE_TAG}"
                    """
                }
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f || true'
            sh "docker logout ${ECR_REGISTRY} || true"
        }
    }
}
