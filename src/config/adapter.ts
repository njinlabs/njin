import s3Adapter from "@njin/core/adapters/s3";

const adapters = {
  file: s3Adapter(),
};

export default adapters;
