const path = require('node:path');

module.exports = {
  entry: './src/index.tsx',
  output: {
    clean: true,
    filename: 'extension-workflows.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {loader: 'ts-loader', options: {transpileOnly: true}}
      }
    ]
  },
  resolve: {extensions: ['.tsx', '.ts', '.js']},
  externals: {react: 'React'}
};
