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

  const pyproject = path.join(backendPath, 'pyproject.toml');
  if (await fileExistsFn(pyproject)) {
    return {
      command: 'python',
      args: ['-m', 'pip', 'install', '-e', '.'],
      cwd: backendPath
    };
  }

  const goMod = path.join(backendPath, 'go.mod');
  if (await fileExistsFn(goMod)) {
    return {
      command: 'go',
      args: ['mod', 'download'],
      cwd: backendPath
    };
  }

  const cargoToml = path.join(backendPath, 'Cargo.toml');
  if (await fileExistsFn(cargoToml)) {
    return {
      command: 'cargo',
      args: ['fetch'],
      cwd: backendPath
    };
  }

  const composerJson = path.join(backendPath, 'composer.json');
  if (await fileExistsFn(composerJson)) {
    return {
      command: 'composer',
      args: ['install'],
      cwd: backendPath
    };
  }

  const gemfile = path.join(backendPath, 'Gemfile');
  if (await fileExistsFn(gemfile)) {
    return {
      command: 'bundle',
      args: ['install'],
      cwd: backendPath
    };
  }

  const packageSwift = path.join(backendPath, 'Package.swift');
  if (await fileExistsFn(packageSwift)) {
    return {
      command: 'swift',
      args: ['package', 'resolve'],
      cwd: backendPath
    };
  }

  const pomXml = path.join(backendPath, 'pom.xml');
  if (await fileExistsFn(pomXml)) {
    return {
      command: 'mvn',
      args: ['-q', '-DskipTests', 'package'],
      cwd: backendPath
    };
  }

  const buildGradle = path.join(projectPath, 'build.gradle');
  if (await fileExistsFn(buildGradle)) {
    const gradleBat = path.join(projectPath, 'gradlew.bat');
    if (await fileExistsFn(gradleBat)) {
      return {
        command: gradleBat,
        args: ['build', '-x', 'test'],
        cwd: projectPath
      };
    }

    const gradleSh = path.join(projectPath, 'gradlew');
    if (await fileExistsFn(gradleSh)) {
      return {
        command: gradleSh,
        args: ['build', '-x', 'test'],
        cwd: projectPath
      };
    }

    return {
      command: 'gradle',
      args: ['build', '-x', 'test'],
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
