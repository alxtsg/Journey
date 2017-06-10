'use strict';

const exif = require('fast-exif');
const mustache = require('mustache');

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const configFile = path.join(
  __dirname,
  'config.json'
);
const templatePath = path.join(
  __dirname,
  'template.mustache'
);
const exitCode = {
  incorrectArguments: 1
};

let inputDirectory = null;
let thumbnailsDirectory = null;
let generatedPagePath = null;
let gmPath = null;
let photos = null;

/**
 * Prints program usage.
 */
function usage() {
  const scriptPath = process.argv[1];
  console.error(`Usage: node ${scriptPath} <input-dir>`);
}

/**
 * Checks if the given directory is valid.
 *
 * @param {String} directory Directory path.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function checkDirectory(directory) {
  return new Promise((resolve, reject) => {
    fs.stat(directory, (error, stats) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (!stats.isDirectory()) {
        const errorMessage = `${directory} is not a directory.`;
        reject(new Error(errorMessage));
        return;
      }
      resolve();
    });
  });
}

/**
 * Gets configurations, including the path of GraphicsMagick.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function getConfigurations() {
  return new Promise((resolve, reject) => {
    fs.readFile(
      configFile,
      {
        encoding: 'utf8'
      },
      (error, data) => {
        if (error !== null) {
          reject(error);
          return;
        }
        try {
          const config = JSON.parse(data);
          if (!config.gmPath) {
            reject(new Error('Path of GraphicsMagick is unspecified'));
            return;
          }
          gmPath = config.gmPath;
          resolve();
        } catch (parseError) {
          reject(parseError);
        }
      });
  });
}

/**
 * Gets filenames of photos from the given directory.
 *
 * The photos array is initialized with objects which each contains the filename
 * and the absolute path of the photo.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function getPhotos() {
  return new Promise((resolve, reject) => {
    fs.readdir(inputDirectory, (error, filenames) => {
      if (error !== null) {
        reject(error);
        return;
      }
      photos = [];
      filenames.forEach((filename) => {
        photos.push({
          filename: filename,
          path: path.join(inputDirectory, filename)
        });
      });
      resolve();
    });
  });
}

/**
 * Gets modification time of the photo.
 *
 * The modification time of each photo is added to the objects in the photos
 * array. The modification time is represented in ISO8601 format up to seconds
 * part. The timezone of the modification time is the one used in the location
 * where the photo was taken.
 *
 * @param {String} photoPath Path of the photo.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function getPhotoModificationTime(photoPath) {
  return new Promise((resolve, reject) => {
    exif.read(photoPath)
      .then((metadata) => {
        if (!metadata) {
          reject(new Error(`No metadata in ${photoPath}.`));
          return;
        }
        if (!metadata.exif) {
          reject(new Error(`No EXIF data in ${photoPath}.`));
          return;
        }
        if (!metadata.exif.DateTimeOriginal) {
          reject(new Error(`Cannot find modification time in ${photoPath}.`));
          return;
        }
        let modificationTime = metadata.exif.DateTimeOriginal.toISOString();
        modificationTime = modificationTime.substring(
          0,
          modificationTime.indexOf('.')
        );
        for (let i = 0; i < photos.length; i += 1) {
          const photo = photos[i];
          if (photo.path === photoPath) {
            photo.modificationTime = modificationTime;
            break;
          }
        }
        resolve();
      })
      .catch((error) => {
        reject(error);
      });
  });
}

/**
 * Gets photos' modification time.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function getPhotosModificationTime() {
  return new Promise((resolve, reject) => {
    const promises = [];
    photos.forEach((photo) => {
      promises.push(getPhotoModificationTime(photo.path));
    });
    Promise.all(promises)
      .then(() => {
        resolve();
      })
      .catch((error) => {
        reject(error);
      });
  });
}

/**
 * Creates thumbnails directory.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function createThumbnailsDirectory() {
  return new Promise((resolve, reject) => {
    fs.mkdir(thumbnailsDirectory, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Resizes photos in batch using GraphicsMagick.
 *
 * @returns {Promise} Resolves with success, or rejects with an Error object.
 */
function batchResize() {
  return new Promise((resolve, reject) => {
    const commandArguments = [
      'batch',
      '-'
    ];
    const gm = childProcess.spawn(gmPath, commandArguments);
    gm.on('error', (error) => {
      reject(error);
      gm.kill();
    });
    gm.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`GraphicsMagick exit with code ${code}`));
        return;
      }
      resolve();
    });
    const batchCommands = [];
    photos.forEach((photo) => {
      const thumbnailPath = path.join(thumbnailsDirectory, photo.filename);
      const command = [
        'convert',
        '-auto-orient',
        '-geometry',
        '1280x720>',
        '+profile',
        '"*"',
        photo.path,
        thumbnailPath,
        '\n'
      ].join(' ');
      batchCommands.push(command);
    });
    gm.stdin.write(batchCommands.join(''));
    gm.stdin.end();
  });
}

/**
 * Generates a page (HTML document) using the photos.
 *
 * @returns {Promise} Resolves successfully, or rejects with an Error object.
 */
function generatePage() {
  return new Promise((resolve, reject) => {
    fs.readFile(
      templatePath,
      {
        encoding: 'utf8'
      },
      (readTemplateError, template) => {
        if (readTemplateError !== null) {
          reject(readTemplateError);
          return;
        }
        const view = {
          currentTimestamp: (new Date()).toISOString(),
          photos: []
        };
        photos.forEach((photo) => {
          view.photos.push({
            filename: photo.filename,
            altText: `Photo captured at ${photo.modificationTime}.`,
            timestamp: photo.modificationTime
          });
        });
        const generatedContent = mustache.render(template, view);
        fs.writeFile(generatedPagePath, generatedContent, (writePageError) => {
          if (writePageError !== null) {
            reject(writePageError);
            return;
          }
          resolve();
        });
      });
  });
}

if (process.argv.length !== 3) {
  usage();
  process.exit(exitCode.incorrectArguments);
} else {
  inputDirectory = process.argv[2];
  thumbnailsDirectory = path.join(inputDirectory, 'thumbnails');
  generatedPagePath = path.join(inputDirectory, 'index.html');
}

Promise.resolve(inputDirectory)
  .then(checkDirectory)
  .then(getConfigurations)
  .then(getPhotos)
  .then(getPhotosModificationTime)
  .then(createThumbnailsDirectory)
  .then(batchResize)
  .then(generatePage)
  .catch((error) => {
    console.error(error);
  });
