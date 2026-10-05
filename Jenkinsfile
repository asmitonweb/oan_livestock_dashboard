// Registry dashboard: verify every branch; on develop build, push to ECR and
// deploy to the dev cluster with Helm, into the namespace of the registry it
// belongs to. See docs/deployment.md.
//
// Staging is not wired yet: its stages are commented out below, so a missing
// staging credential, namespace or repository can never fail a development
// build. Enable them once staging is prepared (docs/deployment.md).
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
        // Kubeconfig credential of the namespace's deploy identity, dev cluster.
        DEV_KUBECONFIG = "gen2-dev-livestock-kubeconfig"
        // Suffix of the dev environment's public host names
        // (<name>-development.<domain>); the domain comes from the cluster.
        DEV_ENVIRONMENT = "development"
        // The registry's public IAM (Deployment and Service); its cookie domain
        // is the base domain of every public host.
        IAM_DEPLOYMENT = "commons-services-iam-staff-portal-api-pub"
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Verify') {
            // Lint and type-check in a throwaway Node container; the image
            // build type-checks again and compiles.
            steps {
                sh '''
                    docker run --rm -v "$PWD:/src:ro" node:24-slim sh -ec '
                        cp -r /src /work && cd /work
                        npm ci --no-audit --no-fund
                        npm run lint
                        npm run typecheck
                    '
                '''
            }
        }

        stage('ECR Login') {
            when { branch 'develop' }
            // when { anyOf { branch 'develop'; branch 'staging' } }   // staging: not wired yet
            steps {
                withCredentials([[$class: 'AmazonWebServicesCredentialsBinding', credentialsId: 'aws-ecr-creds']]) {
                    sh "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}"
                    // The repository is part of the deployment: create it on the first build.
                    sh """
                        aws ecr describe-repositories --region ${AWS_REGION} --repository-names ${ECR_REPOSITORY} >/dev/null 2>&1 \
                          || aws ecr create-repository --region ${AWS_REGION} --repository-name ${ECR_REPOSITORY} \
                               --image-scanning-configuration scanOnPush=true >/dev/null \
                          || { echo "ECR repository ${ECR_REPOSITORY} is missing and aws-ecr-creds may not create it: create it once in ${AWS_REGION}"; exit 1; }
                    """
                }
            }
        }

        stage('Build & Push') {
            when { branch 'develop' }
            // when { anyOf { branch 'develop'; branch 'staging' } }   // staging: not wired yet
            steps {
                script {
                    env.IMAGE_TAG = env.GIT_COMMIT.take(12)
                    def image = "${ECR_REGISTRY}/${ECR_REPOSITORY}"
                    // The branch also moves a tag of its own name.
                    sh """
                        docker build \
                            --label org.opencontainers.image.revision=${env.GIT_COMMIT} \
                            --label org.opencontainers.image.ref.name=${env.BRANCH_NAME} \
                            -t ${image}:${env.IMAGE_TAG} -t ${image}:${env.BRANCH_NAME} .
                        docker push ${image}:${env.IMAGE_TAG}
                        docker push ${image}:${env.BRANCH_NAME}
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
                        # Every host name derives from the IAM cookie domain of this
                        # namespace (<name>-<environment>.<domain>), read from the IAM
                        # Deployment rather than configured. (The chart can look it up
                        # itself; reading it here keeps the deploy independent of the
                        # Helm version's lookup support.)
                        COOKIE_DOMAIN=\$(kubectl get deployment ${IAM_DEPLOYMENT} -n ${HELM_NAMESPACE} \
                            -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="IAM_STAFF_AUTH_COOKIE_DOMAIN")].value}')
                        [ -n "\$COOKIE_DOMAIN" ] || { echo "no IAM_STAFF_AUTH_COOKIE_DOMAIN on deployment/${IAM_DEPLOYMENT} in ${HELM_NAMESPACE}"; exit 1; }
                        echo "IAM ${IAM_DEPLOYMENT}, cookie domain \$COOKIE_DOMAIN"
                        ARGS="--namespace ${HELM_NAMESPACE} \
                            --set environment=${DEV_ENVIRONMENT} \
                            --set iam.service=${IAM_DEPLOYMENT} --set iam.cookieDomain=\$COOKIE_DOMAIN \
                            --set image.repository=${ECR_REGISTRY}/${ECR_REPOSITORY} \
                            --set image.tag=${env.IMAGE_TAG}"
                        # Render first, so a broken chart or value fails before any change.
                        helm template ${HELM_RELEASE} ${HELM_CHART_DIR} \$ARGS > /dev/null
                        helm upgrade --install ${HELM_RELEASE} ${HELM_CHART_DIR} \$ARGS --wait --timeout 15m
                        kubectl rollout status deployment/${HELM_RELEASE} -n ${HELM_NAMESPACE} --timeout=180s

                        # Ready only means the server answers: check that it reaches its
                        # dashboard-api, through the Service (API server proxy).
                        echo "=== smoke test ==="
                        HEALTH=\$(kubectl get --raw "/api/v1/namespaces/${HELM_NAMESPACE}/services/${HELM_RELEASE}:http/proxy/api/health")
                        echo "\$HEALTH"
                        echo "\$HEALTH" | grep -q '"status":"ok"' || { echo "dashboard cannot reach its dashboard-api"; exit 1; }
                        echo "Deployed ${HELM_RELEASE} ${env.IMAGE_TAG}:"
                        kubectl get virtualservice -n ${HELM_NAMESPACE} -l app.kubernetes.io/instance=${HELM_RELEASE} -o jsonpath='{range .items[*]}  https://{.spec.hosts[0]}{"\\n"}{end}'
                    """
                }
            }
        }

        // stage('Deploy (staging)') {
        //     // Not wired yet. Needs, on the staging cluster: this namespace's deploy
        //     // kubeconfig credential, the registry's IAM and dashboard-api, the
        //     // Keycloak admin Secret, and DNS + nginx for the public host.
        //     when { beforeAgent true; branch 'staging' }
        //     agent { label 'vpn-agent2' }
        //     steps {
        //         unstash 'chart'
        //         withCredentials([file(credentialsId: 'staging-rke2-kubeconfig', variable: 'KUBECONFIG')]) {
        //             sh "helm upgrade --install ${HELM_RELEASE} ${HELM_CHART_DIR} -n ${HELM_NAMESPACE} --set image.repository=${ECR_REGISTRY}/${ECR_REPOSITORY} --set image.tag=${env.IMAGE_TAG} --wait --timeout 15m"
        //         }
        //     }
        // }
    }

    post {
        always {
            sh 'docker image prune -f || true'
            sh "docker logout ${ECR_REGISTRY} || true"
        }
    }
}
