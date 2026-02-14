import path from 'path';
import { startJob } from '../../services/jobRunner.js';
import { dirExists, fileExists } from './helpers.js';

const warnJobFailure = (prefix, error) => {
  console.warn(prefix, error?.message || error);
};

const maybeStartJob = ({ job, startJobFn, warningPrefix }) => {
  try {
    return startJobFn(job);
  } catch (error) {
    warnJobFailure(warningPrefix, error);
    return null;
  }
};

const buildFrontendInstallJob = (projectId, frontendPath) => ({
  projectId,
  type: 'frontend:install',
  displayName: 'Install frontend dependencies',
  command: 'npm',
  args: ['install'],
  cwd: frontendPath
});

const buildBackendInstallJob = ({ projectId, command, args, cwd }) => ({
  projectId,
  type: 'backend:install',
  displayName: 'Install backend dependencies',
  command,
  args,
  cwd
});

const resolveBackendInstallPlan = async ({ backendPath, projectPath, fileExistsFn }) => {
  const npmManifest = path.join(backendPath, 'package.json');
  if (await fileExistsFn(npmManifest)) {
    return {
      command: 'npm',
      args: ['install'],
      cwd: backendPath
    };
  }

  const requirements = path.join(backendPath, 'requirements.txt');
  if (await fileExistsFn(requirements)) {
    return {
      command: 'python',
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      cwd: backendPath
    };
  }

  const buildGradle = path.join(projectPath, 'build.gradle');
  if (await fileExistsFn(buildGradle)) {
    const gradleBat = path.join(projectPath, 'gradlew.bat');
    if (await fileExistsFn(gradleBat)) {
      return {
        command: gradleBat,
        args: ['build'],
        cwd: projectPath
      };
    }

    const gradleSh = path.join(projectPath, 'gradlew');
    if (await fileExistsFn(gradleSh)) {
      return {
        command: gradleSh,
        args: ['build'],
        cwd: projectPath
      };
    }

    return {
      command: 'gradle',
      args: ['build'],
      cwd: projectPath
    };
  }

  return null;
};

export const enqueueInstallJobs = async (
  { projectId, projectPath } = {},
  {
    startJobFn = startJob,
    dirExistsFn = dirExists,
    fileExistsFn = fileExists
  } = {}
) => {
  if (!projectId || !projectPath) {
    return [];
  }

  const jobs = [];
  const frontendPath = path.join(projectPath, 'frontend');
  const backendDir = path.join(projectPath, 'backend');
  const backendPath = await dirExistsFn(backendDir) ? backendDir : projectPath;

  if (await dirExistsFn(frontendPath)) {
    const frontendManifest = path.join(frontendPath, 'package.json');
    if (await fileExistsFn(frontendManifest)) {
      const frontendJob = maybeStartJob({
        job: buildFrontendInstallJob(projectId, frontendPath),
        startJobFn,
        warningPrefix: 'Failed to enqueue frontend install job:'
      });

      if (frontendJob) {
        jobs.push(frontendJob);
      }
    }
  }

  const backendPlan = await resolveBackendInstallPlan({ backendPath, projectPath, fileExistsFn });
  if (backendPlan) {
    const backendJob = maybeStartJob({
      job: buildBackendInstallJob({
        projectId,
        command: backendPlan.command,
        args: backendPlan.args,
        cwd: backendPlan.cwd
      }),
      startJobFn,
      warningPrefix: 'Failed to enqueue backend install job:'
    });

    if (backendJob) {
      jobs.push(backendJob);
    }
  }

  return jobs;
};
